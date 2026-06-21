import "dotenv/config";
import { mkdir } from "fs/promises";
import { resolve } from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { BaseScraper } from "./base.js";
import type { ScrapedProduct, ScrapedVariant } from "../pipeline/types.js";

let _stealthRegistered = false;

const HOME = "https://www.brandsdistribution.com";
const LOGIN_URL = `${HOME}/en/login`;
const CATALOG_URL = `${HOME}/en/catalog`;
const SLEEP_MS = 5000;
const RATE_LIMIT_PATTERN = /too many request|please try again in a few/i;
const RATE_LIMIT_BACKOFFS_SEC = [30, 60, 120, 180, 300];

const sleep = (ms = SLEEP_MS) => new Promise((r) => setTimeout(r, ms));

type LeafCategory = { l1: string; l2: string; href: string };

type RawCard = {
  symbol: string;
  name: string;
  brand: string | null;
  cardCategory: string | null;
  href: string | null;
  image: string | null;
  price: number;
  srp: number | null;
  sizes: { size: string; stock: number }[];
};

export class BrandsdistributionScraper extends BaseScraper {
  readonly id = "brandsdistribution";
  readonly displayName = "Brands Distribution";
  readonly homeUrl = HOME;

  /**
   * Override base launch with anti-fingerprinting tweaks: drop the
   * --enable-automation flag, add --disable-blink-features=AutomationControlled,
   * and persist a Chrome profile under var/ so cookies + localStorage warm
   * up across runs. We let Chromium's real UA through (no override).
   */
  protected async launchBrowser(): Promise<Browser> {
    if (!_stealthRegistered) {
      puppeteer.use(StealthPlugin());
      _stealthRegistered = true;
    }
    const userDataDir = resolve("var", "chrome-profile-brandsdistribution");
    await mkdir(userDataDir, { recursive: true });
    return puppeteer.launch({
      headless: false,
      defaultViewport: null, // use window viewport, not the automation default
      userDataDir,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--start-maximized",
      ],
    }) as unknown as Promise<Browser>;
  }

  async *scrape(): AsyncGenerator<ScrapedProduct> {
    const login = process.env.BRANDSDISTRIBUTION_LOGIN;
    const password = process.env.BRANDSDISTRIBUTION_PASSWORD;
    if (!login || !password)
      throw new Error(
        "BRANDSDISTRIBUTION_LOGIN/BRANDSDISTRIBUTION_PASSWORD env vars required",
      );

    const browser = await this.launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-GB,en;q=0.9,pl;q=0.8",
      });

      console.log(`[${this.id}] login...`);
      try {
        // Run #82518012881 timed out here at the default 30s. Give the post-login
        // redirect chain (cookie consent + bot-check + slow first paint) more room,
        // and dump a screenshot on failure so the next run isn't blind.
        await page.goto(LOGIN_URL, {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        });
      } catch (err) {
        await this.dumpDebug(page, "login-nav").catch(() => {});
        throw err;
      }
      await sleep();
      await this.dismissCookieBanner(page);
      await sleep();
      // Persistent profile may already carry a valid session — /en/login then
      // redirects to / and there is no #username to fill in.
      const needsLogin = await page.$("#username");
      if (needsLogin) {
        await page.click("#username");
        await page.type("#username", login, { delay: 40 });
        await sleep();
        await page.click("#password");
        await page.type("#password", password, { delay: 40 });
        await sleep();
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
          page.click('#login-form button.btn-brands-form, #login-form input[type="submit"]'),
        ]);
        await sleep();
        if (/\/login(\?|$)/.test(page.url()))
          throw new Error(`[${this.id}] login failed (still on /login)`);
        console.log(`[${this.id}] logged in (url=${page.url()})`);
      } else {
        console.log(`[${this.id}] session already authenticated (url=${page.url()})`);
      }

      await this.ensurePln(page);
      await sleep();

      console.log(`[${this.id}] loading catalog...`);
      await page.goto(CATALOG_URL, { waitUntil: "domcontentloaded" });
      await sleep();
      await this.dismissCookieBanner(page);
      await sleep();
      await page.waitForSelector("ul.filter-sublist", { timeout: 30000 });

      const cats = await this.harvestCategories(page);
      const topLevels = [...new Set(cats.map((c) => c.l1))];
      console.log(
        `[${this.id}] ${topLevels.length} top categories: ${topLevels.join(", ")}`,
      );
      console.log(`[${this.id}] ${cats.length} leaf categories`);

      let idx = 0;
      for (const cat of cats) {
        idx++;
        console.log(
          `[${this.id}] -> category "${cat.l1} > ${cat.l2}" (${idx}/${cats.length})`,
        );
        yield* this.scrapeCategory(page, cat, idx, cats.length);
      }
    } finally {
      await browser.close();
    }
  }

  /**
   * Brandsdistribution and buy2bee share a similar rate limiter that returns
   * a "Too many requests, please try again in a few seconds" interstitial.
   * After any navigation, check for that text and reload with backoff before
   * doing anything else with the page.
   */
  /**
   * Dump a screenshot + first 2KB of HTML into var/debug/ so a failed run on
   * GHA gives us something to look at. Filenames embed the scraper id, a tag,
   * and an ISO timestamp so multiple dumps per run don't clobber each other.
   */
  private async dumpDebug(page: Page, tag: string): Promise<void> {
    const dir = resolve(process.cwd(), "var", "debug");
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const stem = `${this.id}-${tag}-${ts}`;
    try {
      await page.screenshot({
        path: resolve(dir, `${stem}.png`) as `${string}.png`,
        fullPage: true,
      });
    } catch (err) {
      console.warn(`[${this.id}] screenshot failed:`, err);
    }
    try {
      const html = await page.content();
      const { writeFile } = await import("fs/promises");
      await writeFile(resolve(dir, `${stem}.html`), html.slice(0, 2048));
    } catch (err) {
      console.warn(`[${this.id}] content dump failed:`, err);
    }
    console.warn(`[${this.id}] dumped debug artifacts to ${dir}/${stem}.*`);
  }

  private async waitOutRateLimit(page: Page): Promise<void> {
    for (let attempt = 0; attempt < RATE_LIMIT_BACKOFFS_SEC.length; attempt++) {
      const limited = await page.evaluate(
        (re) => new RegExp(re, "i").test(document.body.innerText || ""),
        RATE_LIMIT_PATTERN.source,
      );
      if (!limited) return;
      const waitSec = RATE_LIMIT_BACKOFFS_SEC[attempt];
      console.warn(
        `[${this.id}] rate-limited (${page.url()}); sleeping ${waitSec}s (${attempt + 1}/${RATE_LIMIT_BACKOFFS_SEC.length})`,
      );
      await sleep(waitSec * 1000);
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
      } catch {
        // ignore — next iteration re-checks
      }
    }
    const stillLimited = await page.evaluate(
      (re) => new RegExp(re, "i").test(document.body.innerText || ""),
      RATE_LIMIT_PATTERN.source,
    );
    if (stillLimited) {
      throw new Error(
        `[${this.id}] still rate-limited after ${RATE_LIMIT_BACKOFFS_SEC.reduce((a, b) => a + b, 0)}s of backoff — try again later`,
      );
    }
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        const walk = (root: Document | ShadowRoot): boolean => {
          for (const el of Array.from(
            root.querySelectorAll<HTMLElement>("a, button"),
          )) {
            if ((el.textContent || "").trim().toLowerCase() === "allow all") {
              el.click();
              return true;
            }
          }
          for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
            const sr = (el as HTMLElement & { shadowRoot?: ShadowRoot })
              .shadowRoot;
            if (sr && walk(sr)) return true;
          }
          return false;
        };
        walk(document);
      });
    } catch {
      // banner may not exist on this page
    }
  }

  private async ensurePln(page: Page): Promise<void> {
    const result = await page.evaluate(() => {
      const dd = document.querySelector("li.currency.has-dropdown a");
      const active = dd?.textContent?.trim();
      if (active === "PLN") return { active, switched: false };
      const pln = [...document.querySelectorAll("li.js-change-currency")].find(
        (e) => (e.textContent || "").trim() === "PLN",
      ) as HTMLElement | undefined;
      if (!pln) return { active, switched: false };
      pln.click();
      return { active, switched: true };
    });
    if (result.switched) await sleep();
    console.log(`[${this.id}] currency=PLN (was=${result.active})`);
  }

  private async harvestCategories(page: Page): Promise<LeafCategory[]> {
    return await page.evaluate(() => {
      const out: { l1: string; l2: string; href: string }[] = [];
      const ul = document.querySelector("ul.filter-sublist");
      if (!ul) return out;
      ul.querySelectorAll(":scope > li").forEach((li) => {
        const l1A = li.querySelector(":scope > a") as HTMLAnchorElement | null;
        if (!l1A) return;
        const l1 = (l1A.textContent || "").trim();
        li.querySelectorAll<HTMLAnchorElement>(":scope > ul > li > a").forEach(
          (a) => {
            const l2 = (a.textContent || "").trim();
            const href = a.getAttribute("href") || "";
            if (l1 && l2 && href) out.push({ l1, l2, href });
          },
        );
      });
      return out;
    });
  }

  private async *scrapeCategory(
    page: Page,
    cat: LeafCategory,
    catIdx = 0,
    catTotal = 0,
  ): AsyncGenerator<ScrapedProduct> {
    const baseUrl = new URL(cat.href, HOME);
    const params = baseUrl.search;

    await page.goto(baseUrl.href, { waitUntil: "domcontentloaded" });
    await sleep();
    if (!(await page.$(".catalog-product"))) {
      console.log(`[${this.id}]   empty category`);
      return;
    }

    const totalPages = await page.evaluate(() => {
      const pager = document.querySelector("ul.pagination");
      if (!pager) return 1;
      const nums = [...pager.querySelectorAll<HTMLAnchorElement>("li > a")]
        .map((a) => parseInt((a.textContent || "").trim(), 10))
        .filter((n) => Number.isFinite(n));
      return nums.length > 0 ? Math.max(...nums) : 1;
    });
    console.log(`[${this.id}]   ${totalPages} page(s)`);

    for (let p = 1; p <= totalPages; p++) {
      console.log(
        `[${this.id}]   page ${p}/${totalPages} of "${cat.l1} > ${cat.l2}"` +
          (catTotal > 0 ? ` (cat ${catIdx}/${catTotal})` : ""),
      );
      if (p > 1) {
        await page.goto(`${HOME}/en/catalog/${p}${params}`, {
          waitUntil: "domcontentloaded",
        });
        await sleep();
      }
      if (!(await page.$(".catalog-product"))) break;

      // Scroll once to trigger any lazy image loads; cards are server-rendered.
      await page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight),
      );
      await sleep();

      const products = (await page.evaluate(PARSE_CARDS_JS)) as RawCard[];

      for (const raw of products) {
        if (!raw.symbol || raw.sizes.length === 0) continue;
        const variants: ScrapedVariant[] = raw.sizes.map((s) => ({
          optionValues: [{ optionName: "Rozmiar", value: s.size }],
          price: raw.price,
          srp: raw.srp ?? undefined,
          currency: "PLN",
          stock: s.stock,
        }));
        yield {
          wholesalerId: this.id,
          symbol: raw.symbol,
          name: raw.name,
          brand: raw.brand,
          image: raw.image,
          href: raw.href,
          labels: [],
          categoryPath: dedupePath([cat.l1, cat.l2, raw.cardCategory]),
          variants,
        };
      }
    }
  }
}

// Browser-side parser, kept as a raw string so the tsx transpiler can't
// inject Node-side __name helpers into the body. Returns RawCard[].
const PARSE_CARDS_JS = `
(function () {
  function abs(u) { return u ? new URL(u, location.origin).href : null; }
  function parsePrice(s) {
    if (!s) return null;
    var n = parseFloat(String(s).replace(/[^\\d.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  var cards = document.querySelectorAll(".catalog-product");
  var out = [];
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i];
    var skuEl = c.querySelector(".product-sku");
    var linkEl = c.querySelector(".product-thumbnail a");
    var imgEl = c.querySelector(".product-thumbnail img");
    var nameEl = c.querySelector(".product-name");
    var brandEl = c.querySelector(".product-brand");
    var catEl = c.querySelector(".product-category");
    var detail = c.querySelector(".col-sm-12.detail .col-sm-4");
    var priceEl = (detail && detail.querySelector(".taxable-price .price--amount"))
      || c.querySelector(".col-xs-6 .taxable-price .price--amount");
    var srpEl = detail && detail.querySelector(".retail-price .price--amount");

    var hrefAttr = linkEl && linkEl.getAttribute("href");
    var fallbackSku = "";
    if (hrefAttr) {
      var parts = hrefAttr.split("/").filter(Boolean);
      fallbackSku = parts[parts.length - 1] || "";
    }
    var symbol = (skuEl && skuEl.textContent && skuEl.textContent.trim()) || fallbackSku;
    var price = parsePrice(priceEl && priceEl.textContent);
    if (price == null) continue;

    var sizes = [];
    var rows = c.querySelectorAll("table.sizes tbody tr");
    for (var r = 0; r < rows.length; r++) {
      var tds = rows[r].querySelectorAll("td");
      if (tds.length < 2) continue;
      var size = (tds[0].textContent || "").trim();
      var stock = parseInt((tds[1].textContent || "").trim(), 10);
      if (size && Number.isFinite(stock) && stock > 0) sizes.push({ size: size, stock: stock });
    }

    out.push({
      symbol: symbol,
      name: (nameEl && nameEl.textContent && nameEl.textContent.trim()) || "",
      brand: (brandEl && brandEl.textContent && brandEl.textContent.trim()) || null,
      cardCategory: (catEl && catEl.textContent && catEl.textContent.trim()) || null,
      href: abs(hrefAttr),
      image: abs(imgEl && imgEl.getAttribute("src")),
      price: price,
      srp: parsePrice(srpEl && srpEl.textContent),
      sizes: sizes,
    });
  }
  return out;
})()
`;

function dedupePath(parts: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (out.length && out[out.length - 1].toLowerCase() === p.toLowerCase())
      continue;
    out.push(p);
  }
  return out;
}
