/**
 * Refreshes the OVERSOLES_SESSION_B64 secret by:
 *
 *   1. Running scripts/oversoles-auto-login.applescript inside the user's
 *      real macOS Chrome (no CDP, no Puppeteer — hCaptcha sees a trusted
 *      browser session and lets the login through).
 *   2. Reading the resulting Shopify session cookies out of Chrome's local
 *      SQLite cookie store via chrome-cookies-secure (decrypts via macOS
 *      keychain "Chrome Safe Storage").
 *   3. Filtering to the cookies the scraper actually needs, base64-encoding
 *      the JSON payload, and writing it into .env (preserving other keys).
 *   4. Optionally pushing the same value to the GitHub Actions repo secret
 *      OVERSOLES_SESSION_B64 via `gh secret set`, so CI runs stay in sync.
 *
 * Invoked manually (one-time validation) or by the LaunchAgent at
 * ~/Library/LaunchAgents/com.b2b-scrapers.oversoles-refresh.plist on its schedule.
 */
import "dotenv/config";
import { execFile } from "child_process";
import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { resolve } from "path";
import { promisify } from "util";
import chromeCookies from "chrome-cookies-secure";

const execFileP = promisify(execFile);

// Resolve files relative to where this script lives (so it works equally from
// the repo at scripts/oversoles-refresh-cookies.ts AND from the deployed copy
// at ~/Library/Application Support/b2b-scrapers/oversoles-refresh-cookies.ts).
// The .env we read/write follows process.cwd() so dotenv stays consistent.
const SCRIPT_DIR = import.meta.dirname;
const ENV_PATH = resolve(process.cwd(), ".env");
const APPLESCRIPT_PATH = resolve(SCRIPT_DIR, "oversoles-auto-login.applescript");

// Shopify session cookies for oversoles.com. `_shopify_essential` is the
// HttpOnly+Secure auth marker (rotated on every login); `cart` matches both
// `cart` and `cart_currency` for B2B currency state; `localization` carries
// locale.
const COOKIE_PREFIXES = ["_shopify_essential", "cart", "localization"];

const COOKIE_POLL_ATTEMPTS = 20;
const COOKIE_POLL_INTERVAL_MS = 3000;

function previewCookie(v: string | undefined | null): string {
  if (!v) return "(none)";
  return `${v.slice(0, 20)}... (${v.length} chars)`;
}

type PuppeteerCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None" | "unspecified";
  // chrome-cookies-secure unfortunately emits PascalCase Secure/HttpOnly
  // in the 'puppeteer' format. Capture them so we can normalize.
  Secure?: boolean;
  HttpOnly?: boolean;
};

// Convert Chromium's "WebKit time" (microseconds since 1601-01-01) to a
// Unix epoch in seconds, which is what Puppeteer's setCookie expects.
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;

function normalizeCookieForPuppeteer(c: PuppeteerCookie): PuppeteerCookie {
  const out: PuppeteerCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? "/",
    secure: Boolean(c.Secure ?? c.secure),
    httpOnly: Boolean(c.HttpOnly ?? c.httpOnly),
  };
  if (typeof c.expires === "number" && c.expires > 0) {
    // Heuristic: WebKit microseconds since 1601 are always > 1e16. Unix
    // seconds are < 1e11 for any sane near-future date. Anything in between
    // (Unix ms) we also rescale defensively.
    let unixSeconds: number;
    if (c.expires > 1e16) {
      unixSeconds = c.expires / 1_000_000 - WEBKIT_EPOCH_OFFSET_SECONDS;
    } else if (c.expires > 1e12) {
      unixSeconds = c.expires / 1_000;
    } else {
      unixSeconds = c.expires;
    }
    if (unixSeconds > 0 && unixSeconds < 1e11) {
      out.expires = Math.floor(unixSeconds);
    }
  }
  if (c.sameSite && ["Strict", "Lax", "None"].includes(c.sameSite as string)) {
    out.sameSite = c.sameSite;
  }
  return out;
}

async function main() {
  const email = process.env.OVERSOLES_LOGIN;
  const password = process.env.OVERSOLES_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "OVERSOLES_LOGIN / OVERSOLES_PASSWORD must be set in .env before running this script",
    );
  }

  // Snapshot the pre-login _shopify_essential value. `_shopify_essential`
  // also serves as Shopify's anonymous-visitor cookie — it's set the moment
  // you load /account/login, before any auth happens. Without this snapshot,
  // our post-AppleScript polling would exit immediately on "cookie present"
  // and save the ANONYMOUS value. We need to wait until the value CHANGES
  // (server rotates it to the authenticated value after the login redirect).
  const profileDir =
    process.env.CHROME_PROFILE ?? (await detectActiveChromeProfile());
  const preLoginCookies = (await chromeCookies.getCookiesPromised(
    "https://oversoles.com",
    "puppeteer",
    profileDir,
  )) as PuppeteerCookie[];
  const preLoginValue =
    preLoginCookies.find((c) => c.name === "_shopify_essential")?.value ?? "";
  console.log(
    `[refresh] pre-login _shopify_essential snapshot: ${previewCookie(preLoginValue)}`,
  );

  console.log("[refresh] driving real Chrome to log in...");
  const emailB64 = Buffer.from(email, "utf8").toString("base64");
  const passwordB64 = Buffer.from(password, "utf8").toString("base64");

  try {
    const { stdout } = await execFileP(
      "osascript",
      [APPLESCRIPT_PATH, emailB64, passwordB64],
      { timeout: 120_000 },
    );
    console.log(`[refresh] applescript result: ${stdout.trim()}`);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr.includes("not allowed to send Apple events")) {
      throw new Error(
        "macOS denied AppleScript control of Chrome. Grant in System Settings → Privacy & Security → Automation → (your terminal app) → Google Chrome.",
      );
    }
    if (
      stderr.includes("execution error") &&
      stderr.includes("JavaScript")
    ) {
      throw new Error(
        "Chrome's 'Allow JavaScript from Apple Events' is disabled. Enable it: Chrome menu → View → Developer → Allow JavaScript from Apple Events.",
      );
    }
    throw new Error(`AppleScript login failed:\n${stderr || err}`);
  }

  console.log(`[refresh] reading cookies from Chrome profile: ${profileDir}`);

  // Poll chrome-cookies-secure waiting for `_shopify_essential` value to
  // DIFFER from the pre-login snapshot. The server rotates this cookie on
  // login (anonymous → authenticated), and Chrome flushes the new value to
  // its on-disk SQLite with up to ~30s delay. If we exit on "cookie
  // present" we'd grab the anonymous value the page set before the form
  // ever submitted.
  let raw: PuppeteerCookie[] = [];
  let attempts = 0;
  while (attempts < COOKIE_POLL_ATTEMPTS) {
    attempts++;
    raw = (await chromeCookies.getCookiesPromised(
      "https://oversoles.com",
      "puppeteer",
      profileDir,
    )) as PuppeteerCookie[];
    const current = raw.find((c) => c.name === "_shopify_essential")?.value;
    if (current && current !== preLoginValue) break;
    if (attempts < COOKIE_POLL_ATTEMPTS) {
      console.log(
        `[refresh]   attempt ${attempts}/${COOKIE_POLL_ATTEMPTS}: _shopify_essential value not yet rotated (current=${previewCookie(current)}); waiting ${COOKIE_POLL_INTERVAL_MS}ms...`,
      );
      await new Promise((r) => setTimeout(r, COOKIE_POLL_INTERVAL_MS));
    }
  }

  const allCookieNames = raw.map((c) => c.name).sort();
  console.log(`[refresh] cookies found: ${allCookieNames.join(", ") || "(none)"}`);

  const cookies = raw
    .filter((c) => COOKIE_PREFIXES.some((p) => c.name.startsWith(p)))
    .map(normalizeCookieForPuppeteer);

  const authCookie = cookies.find((c) => c.name === "_shopify_essential");
  if (!authCookie || authCookie.value === preLoginValue) {
    throw new Error(
      `_shopify_essential never rotated to an authenticated value after ${COOKIE_POLL_ATTEMPTS} read attempts (~${(COOKIE_POLL_ATTEMPTS * COOKIE_POLL_INTERVAL_MS) / 1000}s). ` +
        `Pre-login value: ${previewCookie(preLoginValue)}. ` +
        `Post-login value: ${previewCookie(authCookie?.value)}. ` +
        `Either the login click didn't actually authenticate (form rejected creds / hCaptcha intervened), or Chrome hasn't flushed the rotated cookie to disk yet (rare). ` +
        `Open Chrome and verify you're actually logged in at https://oversoles.com, then re-run.`,
    );
  }

  const b64 = Buffer.from(JSON.stringify(cookies), "utf8").toString("base64");
  console.log(
    `[refresh] captured ${cookies.length} cookies (auth=${Boolean(authCookie)}, payload=${b64.length} chars)`,
  );

  await updateEnvKey(ENV_PATH, "OVERSOLES_SESSION_B64", b64);
  console.log(`[refresh] wrote OVERSOLES_SESSION_B64 to ${ENV_PATH}`);

  // Push to GitHub Actions secret so CI stays in sync. Best-effort: if gh
  // isn't installed or the repo isn't determinable, log and continue. The
  // deploy script bakes `GH_REPO=owner/name` into the deployed .env so this
  // works even after the source repo has been deleted; in repo-mode dev (no
  // GH_REPO env), `gh` falls back to inferring the repo from cwd.
  const ghRepo = process.env.GH_REPO;
  const ghArgs = ["secret", "set", "OVERSOLES_SESSION_B64", "--body", b64];
  if (ghRepo) ghArgs.push("--repo", ghRepo);
  try {
    await execFileP("gh", ghArgs, { timeout: 30_000 });
    console.log(
      `[refresh] pushed OVERSOLES_SESSION_B64 to GitHub secret${ghRepo ? ` (repo=${ghRepo})` : ""}`,
    );
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    console.warn(
      `[refresh] could not push to GitHub secret (continuing): ${stderr.trim() || (err as Error).message}`,
    );
  }
}

/**
 * Rewrites a single KEY=VALUE pair in a .env file, preserving other keys and
 * comments. Adds the key at the end if it doesn't exist yet.
 */
async function updateEnvKey(
  path: string,
  key: string,
  value: string,
): Promise<void> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    body = "";
  }
  const lines = body.split("\n");
  const keyRe = new RegExp(`^${key}=`);
  let replaced = false;
  const out = lines.map((line) => {
    if (keyRe.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(`${key}=${value}`);
  }
  await writeFile(path, out.join("\n"), "utf8");
}

/**
 * Reads Chrome's Local State JSON to figure out which profile the user was
 * last active in. That's the directory name (e.g. "Profile 3"), not the
 * display name (e.g. "Michal").
 */
async function detectActiveChromeProfile(): Promise<string> {
  const localStatePath = resolve(
    homedir(),
    "Library/Application Support/Google/Chrome/Local State",
  );
  try {
    const raw = await readFile(localStatePath, "utf8");
    const ls = JSON.parse(raw) as {
      profile?: { last_active_profiles?: string[]; last_used?: string };
    };
    const active =
      ls.profile?.last_active_profiles?.[0] ??
      ls.profile?.last_used ??
      "Default";
    return active;
  } catch {
    return "Default";
  }
}

main().catch((err) => {
  console.error(`[refresh] FAILED: ${(err as Error).message}`);
  process.exit(1);
});
