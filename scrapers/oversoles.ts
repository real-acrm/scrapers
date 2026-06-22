import "dotenv/config";
import { mkdir, mkdtemp, readFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { BaseScraper } from "./base.js";
import type { ScrapedProduct } from "../pipeline/types.js";
import { parseOversolesWorkbook } from "./lib/oversolesXlsx.js";

let _pluginsRegistered = false;

const STOCK_URL = "https://b2b.oversoles.com/stock";
const HOME_URL = "https://oversoles.com";

export class OversolesScraper extends BaseScraper {
  readonly id = "oversoles";
  readonly displayName = "Oversoles";
  readonly homeUrl = HOME_URL;

  protected async launchBrowser(): Promise<Browser> {
    if (!_pluginsRegistered) {
      puppeteer.use(StealthPlugin());
      _pluginsRegistered = true;
    }
    const userDataDir = resolve("var", "chrome-profile-oversoles");
    await mkdir(userDataDir, { recursive: true });
    return puppeteer.launch({
      headless: false,
      channel: "chrome",
      defaultViewport: null,
      userDataDir,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--lang=en-GB,en-US,en",
        "--start-maximized",
      ],
    }) as unknown as Promise<Browser>;
  }

  async *scrape(): AsyncGenerator<ScrapedProduct> {
    const browser = await this.launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
      });
      await this.restoreSession(page);
      const buf = await this.downloadStockExport(page);
      console.log(`[${this.id}] downloaded export (${buf.byteLength} bytes)`);
      const products = parseOversolesWorkbook(buf);
      console.log(`[${this.id}] parsed ${products.length} products`);
      for (const product of products) {
        yield product;
      }
    } finally {
      try {
        const pages = await browser.pages();
        await Promise.all(pages.map((p) => p.close().catch(() => null)));
      } catch {
        // browser may already be disconnected
      }
      await browser.close();
    }
  }

  /**
   * Restores the session cookies captured by `scripts/oversoles-refresh-cookies.ts`
   * (which logs in via the user's real macOS Chrome via AppleScript, side-stepping
   * hCaptcha entirely). The `_shopify_essential` cookie is scoped to `.oversoles.com`,
   * so it covers both the storefront and the `b2b.oversoles.com` download endpoint.
   */
  private async restoreSession(page: Page): Promise<void> {
    const sessionB64 = process.env.OVERSOLES_SESSION_B64;
    if (!sessionB64) {
      throw new Error(
        `[${this.id}] OVERSOLES_SESSION_B64 is not set. ` +
          `Deploy the refresh job once with: bash scripts/deploy-macos.sh ` +
          `(macOS only). It logs into oversoles via your real Chrome and writes ` +
          `OVERSOLES_SESSION_B64 into this .env (also pushes to GitHub Actions secret).`,
      );
    }
    type CookieParam = Parameters<Page["setCookie"]>[0];
    const cookies = JSON.parse(
      Buffer.from(sessionB64, "base64").toString("utf8"),
    ) as CookieParam[];
    await page.setCookie(...cookies);
    console.log(
      `[${this.id}] restored ${cookies.length} cookies from OVERSOLES_SESSION_B64`,
    );
  }

  /**
   * Click an injected anchor pointing at https://b2b.oversoles.com/stock and
   * capture the resulting download via CDP. The anchor route preserves the
   * Referer + sec-fetch-* headers Chrome normally sets — quieter than
   * `page.goto` of the download URL (which throws ERR_ABORTED once Chrome
   * routes the response into the download path).
   *
   * Pattern mirrors `scrapers/goldensneakers.ts:downloadExport`.
   */
  private async downloadStockExport(page: Page): Promise<ArrayBuffer> {
    const dir = await mkdtemp(join(tmpdir(), "oversoles-export-"));
    const session = await page.createCDPSession();
    try {
      await session.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dir,
        eventsEnabled: true,
      } as never);

      const completed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("export download timed out after 90s")),
          90_000,
        );
        session.on("Browser.downloadProgress", (e: { state?: string }) => {
          if (e.state === "completed") {
            clearTimeout(timer);
            resolve();
          } else if (e.state === "canceled") {
            clearTimeout(timer);
            reject(new Error("export download canceled"));
          }
        });
      });

      // Warm the session on the storefront so the click happens from a
      // same-suffix-domain context (Chrome attaches `.oversoles.com` cookies
      // identically either way, but this also dodges any first-touch
      // bot-detection that fires only on cold direct hits to b2b.*).
      await page.goto(HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      if (page.url().includes("/account/login")) {
        throw new Error(
          `[${this.id}] cookies expired — homepage redirected to /account/login. ` +
            `Re-run: npx tsx scripts/oversoles-refresh-cookies.ts ` +
            `(the weekly LaunchAgent should keep this fresh; if it's failing, check ~/Library/Logs/oversoles-refresh.log).`,
        );
      }

      await page.evaluate((href: string) => {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_self";
        document.body.appendChild(a);
        a.click();
      }, STOCK_URL);

      await completed;
      const files = await readdir(dir);
      const xlsx = files.find((f) => f.endsWith(".xlsx")) ?? files[0];
      if (!xlsx) {
        throw new Error(
          `[${this.id}] no file appeared in ${dir} (got: ${files.join(", ") || "(empty)"})`,
        );
      }
      const buf = await readFile(join(dir, xlsx));
      // Sanity check: an HTML login redirect would land here too if cookies
      // were stale. The real catalogue is ~3-4MB; anything tiny is suspect.
      if (buf.byteLength < 50_000) {
        throw new Error(
          `[${this.id}] downloaded file ${xlsx} is only ${buf.byteLength} bytes — ` +
            `cookies likely expired and we got an HTML login page. ` +
            `Re-run: npx tsx scripts/oversoles-refresh-cookies.ts`,
        );
      }
      // Slice into a fresh ArrayBuffer for the parser.
      return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
    } finally {
      await session.detach().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
