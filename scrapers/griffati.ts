import "dotenv/config";
import { mkdir } from "fs/promises";
import { resolve } from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { BaseScraper } from "./base.js";
import type { ScrapedProduct, ScrapedVariant } from "../pipeline/types.js";

let _stealthRegistered = false;

type RawGriffatiCard = {
  symbol: string;
  brand: string | null;
  name: string | null;
  image: string | null;
  href: string;
  listingPrice: number | null;
  listingSrp: number | null;
  variants: RawGriffatiVariant[];
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

const BAGS_LEAF_PATH =
  "/pl/wholesale?tag_4=accessories&tag_5=men-bags&tag_5=women-bags";

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
      // readability. When we serialize functions into the page via .evaluate(),
      // the wrapper references __name in the browser context where it doesn't
      // exist. Shim it as identity before any script runs.
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

  /**
   * Scrape a single leaf category. In list-view mode Griffati renders the full
   * table.table-sizes (size / stock / price) inline inside each product row —
   * no detail page navigation needed at all.
   */
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
      const nums = [...document.querySelectorAll("ul.pagination > li > a")]
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
        .waitForSelector(".filter-results .row .row", { timeout: 20000 })
        .catch(() => {});

      // Each product in list-view is a .row > .small-12 > .row that contains
      // the image column, the inline table.table-sizes, and the price/brand
      // column — everything we need in a single $$eval, no per-product goto.
      const cards = (await page.$$eval(
        ".filter-results > .small-12 > .row",
        parseAllListingCards,
      )) as RawGriffatiCard[];

      console.log(
        `[${this.id}]      page ${pageNum}/${maxPage}: ${cards.length} cards`,
      );
      if (cards.length === 0) break;

      for (const card of cards) {
        yield buildScrapedProduct(card, card.variants, {
          wholesalerId: this.id,
          categoryPath: leaf.path,
        });
      }
    }
  }

  /**
   * Flip to list view if the inactive "Layout list" icon is present. In list
   * view the full size/stock table is rendered inline per card, which is what
   * we rely on to avoid per-product detail page navigations.
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
        const pl = opts.find((d) => (d.textContent || "").trim() === "Polski");
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
 * Runs in the browser via page.$$eval(".filter-results > .small-12 > .row", ...).
 *
 * In list-view mode each product row contains three columns:
 *   - image column (.product-item)
 *   - size table column (.product-item__table → table.table-sizes)
 *   - price/brand column (.price-div)
 *
 * We pull everything — identity, brand, prices, and full variant table — in
 * one round-trip per listing page with no per-product detail navigation.
 */
function parseAllListingCards(rows: Element[]): RawGriffatiCard[] {
  const parsePrice = (raw: string | null | undefined): number | null => {
    if (!raw) return null;
    const m = raw.match(/[\d.,]+/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(/\s/g, "").replace(",", "."));
    return isNaN(n) ? null : n;
  };

  return rows
    .map((row): RawGriffatiCard | null => {
      // symbol from .product-code (e.g. "518902"), falling back to form data-id
      const codeEl = row.querySelector(".product-code");
      const form = row.querySelector(
        "form.addtocart-form",
      ) as HTMLFormElement | null;
      const symbol =
        (codeEl?.textContent ?? "").trim() || form?.dataset.id || null;
      if (!symbol) return null;

      // href from schema.org <meta itemprop="url"> — the canonical product URL
      const hrefMeta = row.querySelector(
        'meta[itemprop="url"]',
      ) as HTMLMetaElement | null;
      const href = hrefMeta?.content ?? window.location.href;

      // image: first non-hidden picture > img
      const img = row.querySelector("picture img") as HTMLImageElement | null;
      const image = img?.src ?? null;

      // brand from schema.org <meta itemprop="brand"> on the root Product node
      // (not the ProductModel children)
      const brandMeta = row.querySelector(
        '[itemtype="http://schema.org/Product"] > meta[itemprop="brand"]',
      ) as HTMLMetaElement | null;
      const brand = brandMeta?.content?.trim() ?? null;

      // name from .product-item__brand (e.g. "Antony Morato Jeans Uomo")
      const nameEl = row.querySelector(".product-item__brand");
      const name = (nameEl?.textContent ?? "").trim() || null;

      // wholesale price from h2.product-item__price
      const listingPrice = parsePrice(
        row.querySelector("h2.product-item__price")?.textContent,
      );

      // retailer/SRP: last .retailer-price.catalog span (first is the label text)
      const retailerEls = row.querySelectorAll(
        ".price-catalog.retailer .retailer-price.catalog",
      );
      const listingSrp = parsePrice(
        retailerEls[retailerEls.length - 1]?.textContent,
      );

      // variants from the inline table.table-sizes
      // stock is read from input[data-max] — more reliable than td text which
      // can carry whitespace or formatting noise.
      const variants: RawGriffatiVariant[] = [];
      const seen = new Set<string>();
      for (const tr of row.querySelectorAll("table.table-sizes tbody tr")) {
        const tds = tr.querySelectorAll("td.table-cell");
        if (tds.length < 3) continue;
        const size = (tds[0].textContent ?? "").trim();
        const input = tr.querySelector(
          "input.quantity-container",
        ) as HTMLInputElement | null;
        const stock = input
          ? parseInt(input.dataset.max ?? "0", 10)
          : parseInt((tds[1].textContent ?? "").replace(/[^\d]/g, ""), 10);
        const price = parsePrice(tds[2].textContent);
        if (!size || !Number.isFinite(stock) || seen.has(size)) continue;
        seen.add(size);
        variants.push({ size, stock, price });
      }

      return {
        symbol,
        brand,
        name,
        image,
        href,
        listingPrice,
        listingSrp,
        variants,
      };
    })
    .filter((x): x is RawGriffatiCard => x !== null);
}

function buildScrapedProduct(
  card: RawGriffatiCard,
  variantsRaw: RawGriffatiVariant[],
  ctx: { wholesalerId: string; categoryPath: string[] },
): ScrapedProduct {
  const variants: ScrapedVariant[] = variantsRaw.map((v) => ({
    optionValues: [{ optionName: "Rozmiar", value: v.size }],
    price: v.price ?? card.listingPrice,
    ...(card.listingSrp !== null && { srp: card.listingSrp }),
    currency: "EUR" as const,
    stock: v.stock,
  }));

  if (variants.length === 0) {
    // No size table found (sold out / unusual layout) — record a single
    // zero-stock placeholder so the product still lands in the DB.
    variants.push({
      optionValues: [{ optionName: "Wariant", value: "default" }],
      price: card.listingPrice,
      ...(card.listingSrp !== null && { srp: card.listingSrp }),
      currency: "EUR" as const,
      stock: 0,
    });
  }

  return {
    wholesalerId: ctx.wholesalerId,
    symbol: card.symbol,
    name: card.name ?? card.symbol,
    brand: card.brand,
    image: card.image,
    href: card.href,
    categoryPath: ctx.categoryPath,
    variants,
  };
}
