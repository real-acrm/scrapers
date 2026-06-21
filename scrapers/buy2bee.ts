import "dotenv/config";
import { mkdir } from "fs/promises";
import { resolve } from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { BaseScraper } from "./base.js";
import type { ScrapedProduct, ScrapedVariant } from "../pipeline/types.js";

let _stealthRegistered = false;

type RawBuy2beeVariant = {
  size: string;
  stock: number;
  price: number | null;
};

type RawBuy2beeProduct = {
  symbol: string;
  brand: string | null;
  name: string | null;
  image: string | null;
  href: string;
  currency: string;
  price: number | null;
  srp: number | null;
  variants: RawBuy2beeVariant[];
};

const L1_LABELS = ["Man", "Woman", "Shoes", "Bags", "Accessories"];

// Flat sleep after every meaningful action — buy2bee rate-limits aggressively
// and the IAI engine on naleo / kajasport never needed this, so we keep it
// confined to this scraper.
const STEP_DELAY_MS = 5000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const pause = (): Promise<void> => sleep(STEP_DELAY_MS);

/**
 * Inject `/N` between the catalog path and its query string.
 *   /en/catalog/gender-mens?tag_4=clothing  →  /en/catalog/gender-mens/3?tag_4=clothing
 *   /en/catalog/gender-mens                 →  /en/catalog/gender-mens/3
 * If the URL is already paginated (path ends in `/<digit>`), the trailing
 * segment is replaced.
 */
function buildPageUrl(baseUrl: string, pageNum: number): string {
  const u = new URL(baseUrl);
  const trimmed = u.pathname.replace(/\/\d+$/, "");
  u.pathname = `${trimmed}/${pageNum}`;
  return u.toString();
}

export class Buy2beeScraper extends BaseScraper {
  readonly id = "buy2bee";
  readonly displayName = "Buy2bee";
  readonly homeUrl = "https://www.buy2bee.eu";

  /**
   * Override base launch with the same anti-fingerprinting flags that got
   * brandsdistribution past its bot-check (they share a backend stack).
   * Drops --enable-automation, adds AutomationControlled disable, and uses
   * a persistent profile so the local dev loop is fast.
   */
  protected async launchBrowser(): Promise<Browser> {
    if (!_stealthRegistered) {
      puppeteer.use(StealthPlugin());
      _stealthRegistered = true;
    }
    const userDataDir = resolve("var", "chrome-profile-buy2bee");
    await mkdir(userDataDir, { recursive: true });
    return puppeteer.launch({
      headless: false,
      defaultViewport: null,
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
    const login = process.env.BUY2BEE_LOGIN;
    const password = process.env.BUY2BEE_PASSWORD;
    if (!login || !password)
      throw new Error("BUY2BEE_LOGIN/BUY2BEE_PASSWORD env vars required");

    const browser = await this.launchBrowser();
    try {
      const page = await browser.newPage();
      // tsx/esbuild wraps top-level named functions with __name() for stack
      // readability. When we serialize parseBuy2beeCard into the page via
      // .evaluate(), the wrapper references __name in the browser context
      // where it doesn't exist. Shim it as identity before any script runs.
      await page.evaluateOnNewDocument(() => {
        (globalThis as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn;
      });
      // Let Chromium's real UA pass through; matching sec-ch-ua is what got us
      // past the brandsdistribution bot-check.
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-GB,en;q=0.9,pl;q=0.8",
      });

      console.log(`[${this.id}] logging in...`);
      await page.goto(`${this.homeUrl}/en/login`, { waitUntil: "domcontentloaded" });
      await pause();
      await this.dismissCountryPicker(page, "PL");
      await pause();
      await this.acceptCookieBanner(page, "Allow all");
      await pause();

      await page.waitForSelector("#username", { timeout: 10000 });
      // Slow, visible typing + 5s pause between each step so a human watching
      // can follow what's happening (and the site's rate limiter stays calm).
      await page.click("#username");
      await page.type("#username", login, { delay: 100 });
      await pause();
      await page.click("#password");
      await page.type("#password", password, { delay: 100 });
      await pause();
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
        page.evaluate(() =>
          (document.getElementById("login-form") as HTMLFormElement).submit(),
        ),
      ]);
      await pause();
      console.log(`[${this.id}] post-login url=${page.url()}`);
      if (page.url().includes("/en/login")) {
        throw new Error(`[${this.id}] login failed (still on /en/login)`);
      }
      // The post-login redirect target may itself be the "Too many requests"
      // page. Reload with backoff until it isn't.
      for (let attempt = 0; attempt < 5; attempt++) {
        const limited = await page.evaluate(() =>
          /too many request/i.test(document.body.innerText || ""),
        );
        if (!limited) break;
        const waitSec = 60 * (attempt + 1);
        console.warn(
          `[${this.id}] post-login page is rate-limited; sleeping ${waitSec}s (${attempt + 1}/5)`,
        );
        await sleep(waitSec * 1000);
        await page.reload({ waitUntil: "domcontentloaded" });
      }
      const stillLimited = await page.evaluate(() =>
        /too many request/i.test(document.body.innerText || ""),
      );
      if (stillLimited) {
        throw new Error(
          `[${this.id}] still rate-limited after login — wait several minutes before retrying`,
        );
      }
      console.log(`[${this.id}] logged in`);

      // Modal/cookie banner may re-appear after the post-login redirect.
      await this.dismissCountryPicker(page, "PL");
      await pause();
      await this.acceptCookieBanner(page, "Allow all");
      await pause();

      // Hover each L1 (visual confirmation while watching the headful browser).
      for (const label of L1_LABELS) {
        try {
          const a = await page
            .locator(
              `::-p-xpath(//li[contains(@class,"menu-item")][@data-level="1"]/a[normalize-space()="${label}"])`,
            )
            .waitHandle({ signal: AbortSignal.timeout(2000) });
          if (a) await (a as unknown as { hover(): Promise<void> }).hover();
          await sleep(500);
        } catch {
          // hover is cosmetic
        }
      }

      await page
        .waitForSelector('li.menu-item[data-level="1"] > a', { timeout: 15000 })
        .catch(() => {});
      const navs = await page.$$eval(
        'li.menu-item[data-level="1"] > a',
        (anchors, labels) =>
          (anchors as HTMLAnchorElement[])
            .map((a) => ({ label: a.textContent?.trim() ?? "", href: a.href }))
            .filter((x) => (labels as string[]).includes(x.label)),
        L1_LABELS,
      );
      console.log(
        `[${this.id}] ${navs.length} top categories: ${navs.map((n) => n.label).join(", ")}`,
      );
      if (navs.length === 0) {
        const body = await page.evaluate(() =>
          document.body.innerText.slice(0, 400),
        );
        await page.screenshot({ path: "var/buy2bee-no-nav.png", fullPage: true }).catch(() => {});
        throw new Error(
          `[${this.id}] no nav links post-login (url=${page.url()}, body=${body})`,
        );
      }

      let l1Idx = 0;
      for (const l1 of navs) {
        l1Idx++;
        console.log(`[${this.id}] -> L1 "${l1.label}" (${l1Idx}/${navs.length})`);
        const cat4List = await this.readFilterAnchors(page, l1.href, "#filter-dropdown-4");
        console.log(`[${this.id}]   ${cat4List.length} cat4 under "${l1.label}"`);

        if (cat4List.length === 0) {
          yield* this.scrapeLeaf(page, l1.href, [l1.label]);
          continue;
        }

        let cat4Idx = 0;
        for (const cat4 of cat4List) {
          cat4Idx++;
          console.log(
            `[${this.id}]   cat4 "${cat4.name}" (${cat4Idx}/${cat4List.length}) under "${l1.label}"`,
          );
          const cat5List = await this.readFilterAnchors(page, cat4.href, "#filter-dropdown-5");

          if (cat5List.length === 0) {
            yield* this.scrapeLeaf(page, cat4.href, [l1.label, cat4.name]);
            continue;
          }

          let cat5Idx = 0;
          for (const cat5 of cat5List) {
            cat5Idx++;
            console.log(
              `[${this.id}]     cat5 "${cat5.name}" (${cat5Idx}/${cat5List.length})`,
            );
            yield* this.scrapeLeaf(page, cat5.href, [l1.label, cat4.name, cat5.name]);
          }
        }
      }
    } finally {
      await browser.close();
    }
  }

  /**
   * Navigate to the listing URL, then read the L2/L3 filter anchors out of
   * the chosen dropdown. We read both visible and `li.filter.hide` items —
   * "See all sottocategory" only flips CSS; the anchors are already in DOM.
   */
  private async readFilterAnchors(
    page: Page,
    url: string,
    dropdownSel: string,
  ): Promise<{ name: string; href: string }[]> {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await pause();
    await this.dismissCountryPicker(page, "PL");
    return page.evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return [];
      return [...root.querySelectorAll("ul.filters-list li.filter a")]
        .map((a) => ({
          name: a.querySelector("label")?.textContent?.trim() ?? "",
          href: (a as HTMLAnchorElement).href,
        }))
        .filter((x) => x.name && x.href);
    }, dropdownSel);
  }

  /**
   * Scrape every page of a single leaf URL. Reads maxPage from the highest
   * numeric anchor in `ul.pagination`, then navigates `/N` for N=1..maxPage —
   * because buy2bee's "Next page" anchor is actually a "jump to last shown
   * page" button and would skip every page in between.
   */
  private async *scrapeLeaf(
    page: Page,
    leafUrl: string,
    categoryPath: string[],
  ): AsyncGenerator<ScrapedProduct> {
    await page.goto(leafUrl, { waitUntil: "domcontentloaded" });
    await pause();
    await this.dismissCountryPicker(page, "PL");
    await this.ensureListView(page);

    const maxPage = await page.evaluate(() => {
      const nums = [...document.querySelectorAll("ul.pagination > li > a")]
        .map((a) => parseInt((a.textContent ?? "").trim(), 10))
        .filter((n) => Number.isFinite(n));
      return nums.length > 0 ? Math.max(...nums) : 1;
    });
    console.log(`[${this.id}]       ${maxPage} page(s) — ${categoryPath.join(" / ")}`);

    for (let pageNum = 1; pageNum <= maxPage; pageNum++) {
      if (pageNum > 1) {
        await page.goto(buildPageUrl(leafUrl, pageNum), { waitUntil: "domcontentloaded" });
        await pause();
        await this.dismissCountryPicker(page, "PL");
        await this.ensureListView(page);
      }
      await page
        .waitForSelector(".product-container.expanded", { timeout: 20000 })
        .catch(() => {});

      const cards = await page.$$(".product-container.expanded");
      console.log(`[${this.id}]         page ${pageNum}/${maxPage}: ${cards.length} cards`);
      if (cards.length === 0) {
        const body = await page.evaluate(() => document.body.innerText.slice(0, 400));
        console.warn(`[${this.id}] empty page; body sample: ${body}`);
        break;
      }
      for (const card of cards) {
        try {
          const raw = (await card.evaluate(parseBuy2beeCard)) as RawBuy2beeProduct | null;
          if (!raw) continue;
          yield toScrapedProduct(raw, { wholesalerId: this.id, categoryPath });
        } catch (err) {
          console.error("parseBuy2beeCard error:", err);
        }
      }
    }
  }

  /**
   * Click the list-view toggle if the page isn't already in list view. Cheap
   * and idempotent — re-run after every navigation since the view preference
   * doesn't survive URL changes in this skin.
   */
  private async ensureListView(page: Page): Promise<void> {
    const already = await page.$(".product-container.expanded");
    if (already) return;
    const toggle = await page.$('label[for="list-option"]');
    if (!toggle) return;
    await toggle.click();
    await page
      .waitForSelector(".product-container.expanded", { timeout: 10000 })
      .catch(() => {});
    await pause();
  }

  private async dismissCountryPicker(page: Page, countryCode: string): Promise<void> {
    const li = await page.$(`li[data-country="${countryCode}"]`);
    if (!li) return;
    try {
      await li.click();
      await page.waitForFunction(
        () => !document.querySelector("#country-selector .overlay"),
        { timeout: 5000 },
      );
      console.log(`[${this.id}] dismissed country picker (${countryCode})`);
    } catch {
      // overlay may have already closed
    }
  }

  private async acceptCookieBanner(page: Page, text: string): Promise<void> {
    // The Klio consent banner lives inside a declarative shadow root on
    // <z11-event-handler-manager> — light-DOM querySelectors don't reach it.
    const clicked = await page.evaluate((wanted: string) => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length > 0) {
        const root = stack.pop()!;
        const links = root.querySelectorAll("a");
        for (let i = 0; i < links.length; i++) {
          if ((links[i].textContent || "").trim() === wanted) {
            (links[i] as HTMLAnchorElement).click();
            return true;
          }
        }
        const all = root.querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const sr = (all[i] as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (sr) stack.push(sr);
        }
      }
      return false;
    }, text);
    if (clicked) console.log(`[${this.id}] accepted cookies`);
  }
}

/**
 * Runs in the browser via card.evaluate. Parses one .product-container.expanded
 * card from buy2bee's list-view layout.
 */
function parseBuy2beeCard(el: Element): RawBuy2beeProduct | null {
  const parsePrice = (priceEl: Element | null | undefined): number | null => {
    const raw = priceEl?.textContent?.trim() ?? "";
    if (!raw) return null;
    const m = raw.match(/[\d,.\s]+/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(/\s/g, "").replace(",", "."));
    return isNaN(n) ? null : n;
  };

  const link = el.querySelector("a.product-link") as HTMLAnchorElement | null;
  if (!link) return null;
  const symbol = link.pathname.split("/").filter(Boolean).pop() ?? null;
  if (!symbol) return null;

  const brand = el.querySelector(".product-title")?.textContent?.trim() ?? null;
  const name = el.querySelector(".product-subtitle")?.textContent?.trim() ?? null;
  const image =
    (el.querySelector("picture img") as HTMLImageElement)?.src ?? null;
  const currency =
    el.querySelector(".product-price .currency")?.textContent?.trim() || "€";
  const price = parsePrice(el.querySelector(".product-price .price"));
  const srp = parsePrice(el.querySelector(".retail-price .price"));

  const variants: RawBuy2beeVariant[] = [...el.querySelectorAll("table.table-sizes tbody tr")].map(
    (tr) => {
      const tds = tr.querySelectorAll("td");
      const size = tds[0]?.textContent?.trim() ?? "";
      const stockRaw = tds[1]?.textContent?.trim() ?? "";
      const stock = parseInt(stockRaw.replace(/[^\d]/g, ""), 10) || 0;
      const rowPrice = parsePrice(tds[3]?.querySelector(".price"));
      return { size, stock, price: rowPrice };
    },
  );

  return {
    symbol,
    brand,
    name,
    image,
    href: link.href,
    currency,
    price,
    srp,
    variants,
  };
}

function toScrapedProduct(
  raw: RawBuy2beeProduct,
  ctx: { wholesalerId: string; categoryPath: string[] },
): ScrapedProduct {
  const variants: ScrapedVariant[] = raw.variants
    .filter((v) => v.size)
    .map((v) => ({
      optionValues: [{ optionName: "Rozmiar", value: v.size }],
      price: v.price ?? raw.price,
      ...(raw.srp !== null && { srp: raw.srp }),
      currency: raw.currency,
      stock: v.stock,
    }));

  if (variants.length === 0) {
    variants.push({
      optionValues: [{ optionName: "Wariant", value: "default" }],
      price: raw.price,
      ...(raw.srp !== null && { srp: raw.srp }),
      currency: raw.currency,
      stock: 0,
    });
  }

  return {
    wholesalerId: ctx.wholesalerId,
    symbol: raw.symbol,
    name: raw.name ?? raw.symbol,
    brand: raw.brand,
    image: raw.image,
    href: raw.href,
    labels: [],
    categoryPath: ctx.categoryPath,
    variants,
  };
}
