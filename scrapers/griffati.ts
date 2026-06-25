import "dotenv/config";
import { mkdir } from "fs/promises";
import { resolve } from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { BaseScraper } from "./base.js";
import type { ScrapedProduct, ScrapedVariant } from "../pipeline/types.js";

let _stealthRegistered = false;

type RawGriffatiLite = {
  symbol: string;
  brand: string | null;
  name: string | null;
  image: string | null;
  href: string;
  listingPrice: number | null;
  listingSrp: number | null;
};

type RawGriffatiVariant = {
  size: string;
  stock: number;
  price: number | null;
};

type Leaf = { href: string; path: string[] };

// Griffati ships the whole menu graph as hidden HTML on every page (mobile
// submenu containers). The data-ref slugs are stable across languages; we
// read the visible top-nav label off the DOM so categoryPath matches whatever
// language the session is in (Polish, per requirements). The BAGS_FALLBACK
// label is only used if the top-nav link has no readable text.
const L1_REFS: string[] = ["men", "women", "accessories", "shoes"];
const BAGS_FALLBACK_LABEL = "Torebki";

const BAGS_LEAF_PATH = "/pl/wholesale?tag_4=accessories&tag_5=men-bags&tag_5=women-bags";

const STEP_DELAY_MS = 5000;
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const pause = (): Promise<void> => sleep(STEP_DELAY_MS);

// Inject `/N` between the catalog path and its query string.
//   /en/wholesale/clothing/gender-men?tag_108=men-jackets
//     → /en/wholesale/clothing/gender-men/3?tag_108=men-jackets
// If the URL is already paginated (path ends in `/<digit>`), the trailing
// segment is replaced. Same scheme as buy2bee.
function buildPageUrl(baseUrl: string, pageNum: number): string {
  const u = new URL(baseUrl);
  const trimmed = u.pathname.replace(/\/\d+$/, "");
  u.pathname = `${trimmed}/${pageNum}`;
  return u.toString();
}

export class GriffatiScraper extends BaseScraper {
  readonly id = "griffati";
  readonly displayName = "Griffati";
  readonly homeUrl = "https://www.griffati.com";

  protected async launchBrowser(): Promise<Browser> {
    if (!_stealthRegistered) {
      puppeteer.use(StealthPlugin());
      _stealthRegistered = true;
    }
    const userDataDir = resolve("var", "chrome-profile-griffati");
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
    const login = process.env.GRIFFATI_LOGIN;
    const password = process.env.GRIFFATI_PASSWORD;
    if (!login || !password)
      throw new Error("GRIFFATI_LOGIN/GRIFFATI_PASSWORD env vars required");

    const browser = await this.launchBrowser();
    try {
      const page = await browser.newPage();
      // tsx/esbuild wraps top-level named functions with __name() for stack
      // readability. When we serialize parseGriffatiCard into the page via
      // .evaluate(), the wrapper references __name in the browser context
      // where it doesn't exist. Shim it as identity before any script runs.
      await page.evaluateOnNewDocument(() => {
        (globalThis as unknown as { __name: (fn: unknown) => unknown }).__name =
          (fn) => fn;
      });
      await page.setExtraHTTPHeaders({
        "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
      });

      console.log(`[${this.id}] logging in...`);
      await page.goto(`${this.homeUrl}/pl/login`, {
        waitUntil: "domcontentloaded",
      });
      await pause();
      await this.dismissLanguageModal(page);
      await this.acceptCookieBanner(page);
      await pause();

      // Persistent profile may already hold a valid session — the /login
      // page redirects away once the auth cookie is present. Short-circuit
      // the form fill in that case.
      const alreadyLogged = await page.evaluate(() =>
        document.body.classList.contains("logged"),
      );
      if (alreadyLogged) {
        console.log(`[${this.id}] reused existing session (url=${page.url()})`);
      } else {
        await page.waitForSelector("#username", { timeout: 15000 });
        await page.click("#username");
        await page.type("#username", login, { delay: 100 });
        await pause();
        await page.click("#password");
        await page.type("#password", password, { delay: 100 });
        await pause();
        await Promise.all([
          page
            .waitForNavigation({
              waitUntil: "domcontentloaded",
              timeout: 30000,
            })
            .catch(() => {}),
          page.evaluate(() =>
            (document.getElementById("login-form") as HTMLFormElement).submit(),
          ),
        ]);
        await pause();
        if (/\/(pl|en)\/login/.test(page.url())) {
          throw new Error(`[${this.id}] login failed (still on /login)`);
        }
        console.log(`[${this.id}] logged in (url=${page.url()})`);
      }
      await this.dismissLanguageModal(page);
      await this.acceptCookieBanner(page);

      const leaves = await this.extractLeaves(page);
      console.log(`[${this.id}] ${leaves.length} leaf categories discovered`);
      if (leaves.length === 0) {
        await page
          .screenshot({ path: "var/griffati-no-leaves.png", fullPage: true })
          .catch(() => {});
        throw new Error(`[${this.id}] menu graph was empty post-login`);
      }

      let i = 0;
      for (const leaf of leaves) {
        i++;
        console.log(
          `[${this.id}] -> (${i}/${leaves.length}) ${leaf.path.join(" / ")}`,
        );
        try {
          yield* this.scrapeLeaf(page, leaf);
        } catch (err) {
          console.error(`[${this.id}] leaf failed (${leaf.href}):`, err);
        }
      }
    } finally {
      await browser.close();
    }
  }

  /**
   * Parse the hidden mobile-submenu containers that ship with every page.
   * They hold the full L1 → L2 → L3 graph; the desktop hover overlay is just
   * a render of the same data. Skipping "Best brands" / "Season" L2 entries
   * and the brands column of each L3 box, per spec.
   */
  private async extractLeaves(page: Page): Promise<Leaf[]> {
    const raw = (await page.evaluate(
      (l1Refs, bagsHref, bagsFallback) => {
        const out: { href: string; path: string[] }[] = [];
        // Pull the Polish L1 label off the live top-nav <li> so categoryPath
        // matches whatever language the session is rendered in.
        const labelFor = (ref: string): string => {
          const li = document.querySelector(
            `li.main-menu-item[data-target="${ref}"]`,
          );
          return (li?.textContent || "").trim() || ref;
        };
        for (const ref of l1Refs) {
          const label = labelFor(ref);
          const l1Box = document.querySelector(
            `#submenus-container-mobile [data-ref="${ref}"]`,
          );
          if (!l1Box) continue;
          const l2Items = [
            ...l1Box.querySelectorAll("li.submenu-item[data-target]"),
          ]
            .map((li) => {
              const el = li as HTMLElement;
              const target = el.dataset.target || "";
              const breadcrumb = (el.dataset.breadcrumb || "").trim();
              const text = (el.textContent || "").trim();
              return { target, label: breadcrumb || text };
            })
            .filter((x) => x.target && !/-(brands|season)$/.test(x.target));

          for (const l2 of l2Items) {
            const l3Box = document.querySelector(
              `#subsubmenus-container-mobile [data-ref="${l2.target}"]`,
            );
            if (!l3Box) continue;
            const catCol =
              l3Box.querySelector('[data-ref="categories"]') || l3Box;
            const l3Items = [
              ...catCol.querySelectorAll("a.subsubmenu-item"),
            ] as HTMLAnchorElement[];
            for (const a of l3Items) {
              const name = (a.textContent || "").trim();
              if (!name || !a.href) continue;
              out.push({ href: a.href, path: [label, l2.label, name] });
            }
          }
        }

        // Bags is a direct top-level link with no overlay/sub-categories.
        // Read its label off the live nav so it's the localized one (Polish).
        const bagsLi = document.querySelector(
          'li.main-menu-item.link a[href*="men-bags"]',
        );
        const bagsLabel = (bagsLi?.textContent || "").trim() || bagsFallback;
        out.push({
          href: new URL(bagsHref, window.location.origin).href,
          path: [bagsLabel],
        });
        return out;
      },
      L1_REFS,
      BAGS_LEAF_PATH,
      BAGS_FALLBACK_LABEL,
    )) as { href: string; path: string[] }[];

    return raw;
  }

  private async *scrapeLeaf(
    page: Page,
    leaf: Leaf,
  ): AsyncGenerator<ScrapedProduct> {
    await page.goto(leaf.href, { waitUntil: "domcontentloaded" });
    await pause();
    await this.dismissLanguageModal(page);
    await this.acceptCookieBanner(page);
    await this.ensureListView(page);

    const maxPage = await page.evaluate(() => {
      const nums = [
        ...document.querySelectorAll("ul.pagination > li > a"),
      ]
        .map((a) => parseInt((a.textContent ?? "").trim(), 10))
        .filter((n) => Number.isFinite(n));
      return nums.length > 0 ? Math.max(...nums) : 1;
    });
    console.log(
      `[${this.id}]    ${maxPage} page(s) — ${leaf.path.join(" / ")}`,
    );

    for (let pageNum = 1; pageNum <= maxPage; pageNum++) {
      if (pageNum > 1) {
        await page.goto(buildPageUrl(leaf.href, pageNum), {
          waitUntil: "domcontentloaded",
        });
        await pause();
        await this.ensureListView(page);
      }
      await page
        .waitForSelector(".product-item", { timeout: 20000 })
        .catch(() => {});

      // One $$eval lifts every card's lite-data into memory before we leave
      // the listing page; subsequent navigations to detail URLs invalidate
      // ElementHandles, so we can't iterate cards one-by-one.
      const lites = (await page.$$eval(
        ".product-item",
        parseAllListingCards,
      )) as RawGriffatiLite[];
      console.log(
        `[${this.id}]      page ${pageNum}/${maxPage}: ${lites.length} cards`,
      );
      if (lites.length === 0) {
        break;
      }

      for (const lite of lites) {
        try {
          // Some detail pages have slow third-party scripts (Klio chat,
          // hotjar) that keep the lifecycle event from firing within 30s.
          // Allow 60s, swallow the lifecycle timeout, then gate on the
          // size table being present — that's the only DOM we actually need.
          await page
            .goto(lite.href, {
              waitUntil: "domcontentloaded",
              timeout: 60000,
            })
            .catch((err: Error) => {
              console.warn(
                `[${this.id}] ${lite.symbol}: nav lifecycle did not settle (${err.message}); proceeding`,
              );
            });
          await pause();
          const tableReady = await page
            .waitForSelector("table.table-sizes", { timeout: 15000 })
            .catch(() => null);
          const variants = tableReady
            ? ((await page.evaluate(
                parseDetailSizeTable,
              )) as RawGriffatiVariant[])
            : [];
          yield buildScrapedProduct(lite, variants, {
            wholesalerId: this.id,
            categoryPath: leaf.path,
          });
        } catch (err) {
          console.error(
            `[${this.id}] detail parse error (${lite.symbol}):`,
            err,
          );
        }
      }
    }
  }

  /**
   * Flip to list view if the inactive "Layout list" icon is present. Both
   * list and card layouts use identical .product-item markup, so this is
   * cosmetic — but it matches the manual workflow and reduces per-page
   * card count, which is gentler on the server.
   */
  private async ensureListView(page: Page): Promise<void> {
    const flipped = await page.evaluate(() => {
      const imgs = [
        ...document.querySelectorAll('img.layout-grid-img[alt="Layout list"]'),
      ] as HTMLImageElement[];
      const inactive = imgs.find((i) => !i.classList.contains("active"));
      if (!inactive) return false;
      inactive.click();
      return true;
    });
    if (flipped) await pause();
  }

  private async dismissLanguageModal(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        const modal = document.getElementById("revealanguage");
        if (!modal) return false;
        const style = window.getComputedStyle(modal);
        if (style.display === "none" || style.visibility === "hidden")
          return false;
        const opts = [...modal.querySelectorAll("div")] as HTMLElement[];
        const pl = opts.find(
          (d) => (d.textContent || "").trim() === "Polski",
        );
        if (pl) pl.click();
        return !!pl;
      })
      .catch(() => false);
  }

  private async acceptCookieBanner(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        const links = [...document.querySelectorAll("a")];
        const allow = links.find(
          (a) => (a.textContent || "").trim() === "Allow all",
        );
        if (allow) (allow as HTMLAnchorElement).click();
        return !!allow;
      })
      .catch(() => false);
  }
}

/**
 * Runs in the browser via page.$$eval(".product-item", parseAllListingCards).
 * Pulls every card's lite data in one round-trip so we can leave the listing
 * page immediately; once we navigate to a detail URL, any ElementHandles into
 * the prior listing become invalid.
 *
 * Stock isn't on the listing — only the product detail page exposes the
 * Size/Availab/Price/Quantity table. Listing only gives us a deduped size
 * badge list, which is informationally a subset of what the detail table
 * carries, so we lift just identity/branding/price-hint here.
 */
function parseAllListingCards(els: Element[]): RawGriffatiLite[] {
  const parsePrice = (raw: string | null | undefined): number | null => {
    if (!raw) return null;
    const m = raw.match(/[\d.,]+/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(/\s/g, "").replace(",", "."));
    return isNaN(n) ? null : n;
  };

  return els
    .map((el): RawGriffatiLite | null => {
      const ds = (el as HTMLElement).dataset;
      const symbol =
        ds.openreveal || (ds.url || "").split("/").filter(Boolean).pop();
      if (!symbol) return null;

      const href = ds.url
        ? new URL(ds.url, window.location.origin).href
        : window.location.href;

      const img = el.querySelector("picture img") as HTMLImageElement | null;
      const image = img?.src || null;

      // .product_brand = "Adidas Originals - Mężczyzna Sneakers Mężczyzna".
      const productBrandText =
        el.querySelector(".product_brand")?.textContent?.trim() || "";
      const [brandPart, ...rest] = productBrandText.split(" - ");
      const brand = brandPart?.trim() || null;
      const category = rest.join(" - ").trim();
      const name =
        [brand, category].filter(Boolean).join(" ").trim() ||
        img?.alt?.trim() ||
        null;

      const listingPrice = parsePrice(
        el.querySelector(".product-item__price")?.textContent,
      );
      const retailerPriceEls = el.querySelectorAll(
        ".price-catalog.retailer .retailer-price.catalog",
      );
      const listingSrp = parsePrice(
        retailerPriceEls[retailerPriceEls.length - 1]?.textContent,
      );

      return {
        symbol,
        brand,
        name,
        image,
        href,
        listingPrice,
        listingSrp,
      };
    })
    .filter((x): x is RawGriffatiLite => x !== null);
}

/**
 * Runs in the browser via page.evaluate on a product detail page. Reads the
 * Size/Availab/Price/Quantity rows from table.table-sizes — each <tr> with
 * td.table-cell cells is one in-stock SKU.
 */
function parseDetailSizeTable(): RawGriffatiVariant[] {
  const parsePrice = (raw: string | null | undefined): number | null => {
    if (!raw) return null;
    const m = raw.match(/[\d.,]+/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(/\s/g, "").replace(",", "."));
    return isNaN(n) ? null : n;
  };

  const table = document.querySelector("table.table-sizes");
  if (!table) return [];

  const out: RawGriffatiVariant[] = [];
  const seen = new Set<string>();
  for (const tr of table.querySelectorAll("tr")) {
    const tds = tr.querySelectorAll("td.table-cell");
    // Header rows use <th> — skip anything without 4 td.table-cell columns.
    if (tds.length < 3) continue;
    const size = (tds[0].textContent || "").trim();
    const stock = parseInt(
      (tds[1].textContent || "").replace(/[^\d]/g, ""),
      10,
    );
    const price = parsePrice(tds[2].textContent);
    if (!size || !Number.isFinite(stock)) continue;
    // Defensive dedup: shouldn't happen in this table but cheap insurance.
    if (seen.has(size)) continue;
    seen.add(size);
    out.push({ size, stock, price });
  }
  return out;
}

function buildScrapedProduct(
  lite: RawGriffatiLite,
  variantsRaw: RawGriffatiVariant[],
  ctx: { wholesalerId: string; categoryPath: string[] },
): ScrapedProduct {
  const variants: ScrapedVariant[] = variantsRaw.map((v) => ({
    optionValues: [{ optionName: "Rozmiar", value: v.size }],
    price: v.price ?? lite.listingPrice,
    ...(lite.listingSrp !== null && { srp: lite.listingSrp }),
    currency: "EUR" as const,
    stock: v.stock,
  }));

  if (variants.length === 0) {
    // Product page had no size table (sold out / unusual layout) — record
    // a single zero-stock placeholder so the product still lands in the DB.
    variants.push({
      optionValues: [{ optionName: "Wariant", value: "default" }],
      price: lite.listingPrice,
      ...(lite.listingSrp !== null && { srp: lite.listingSrp }),
      currency: "EUR" as const,
      stock: 0,
    });
  }

  return {
    wholesalerId: ctx.wholesalerId,
    symbol: lite.symbol,
    name: lite.name ?? lite.symbol,
    brand: lite.brand,
    image: lite.image,
    href: lite.href,
    categoryPath: ctx.categoryPath,
    variants,
  };
}
