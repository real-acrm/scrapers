import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, ElementHandle, Page } from "puppeteer";
import type { ScrapedProduct } from "../pipeline/types.js";
import {
  chunkForBatches,
  fetchBatch,
  jitterMs,
  toScrapedVariants,
  type QueryTemplate,
} from "./lib/graphqlVariants.js";

/** One colour-version pulled from a listing card's DOM (metadata the API omits). */
type CardVersion = {
  id: string;
  name: string | null;
  brand: string | null;
  image: string | null;
  href: string | null;
};

let _stealthRegistered = false;

export abstract class BaseScraper {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly homeUrl: string;

  abstract scrape(): AsyncGenerator<ScrapedProduct>;

  protected async launchBrowser(): Promise<Browser> {
    if (!_stealthRegistered) {
      puppeteer.use(StealthPlugin());
      _stealthRegistered = true;
    }
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    return puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1280, height: 900 },
      args: ["--no-sandbox"],
      ...(executablePath ? { executablePath } : {}),
    }) as unknown as Promise<Browser>;
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  protected async acceptCookies(page: Page, selector: string): Promise<void> {
    try {
      const btn = await page.waitForSelector(selector, { timeout: 10000 });
      if (btn) await btn.click();
    } catch {
      // No banner — fine.
    }
  }

  protected async clickByText(
    page: Page,
    tag: string,
    text: string,
  ): Promise<void> {
    const el = await page
      .locator(`::-p-xpath(//${tag}[normalize-space()="${text}"])`)
      .waitHandle();
    if (!el) throw new Error(`Element <${tag}> with text "${text}" not found`);
    await el.evaluate((node) => (node as HTMLElement).click());
  }

  protected async waitForText(
    page: Page,
    tag: string,
    text: string,
    timeout = 30000,
  ): Promise<void> {
    await page.waitForFunction(
      ({ tag, text }: { tag: string; text: string }) =>
        [...document.querySelectorAll(tag)].some(
          (el) => el.textContent?.trim() === text,
        ),
      { timeout },
      { tag, text },
    );
  }

  protected async waitForNetworkIdle(
    page: Page,
    urlSubstring: string,
    timeout = 30000,
    idleTime = 500,
  ): Promise<void> {
    let inFlight = 0;
    const onRequest = (req: { url(): string }) => {
      if (req.url().includes(urlSubstring)) inFlight++;
    };
    const onDone = (req: { url(): string }) => {
      if (req.url().includes(urlSubstring)) inFlight--;
    };
    page.on("request", onRequest as never);
    page.on("requestfinished", onDone as never);
    page.on("requestfailed", onDone as never);
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), timeout);
        const check = setInterval(() => {
          if (inFlight === 0) {
            clearInterval(check);
            clearTimeout(timer);
            resolve();
          }
        }, idleTime);
      });
    } finally {
      page.off("request", onRequest as never);
      page.off("requestfinished", onDone as never);
      page.off("requestfailed", onDone as never);
    }
  }

  /**
   * Archetype A: parses everything from category listing pages.
   * Yields products as it parses each card — never accumulates the full list.
   */
  protected async *paginateAndYield(
    page: Page,
    productCardSelector: string,
    nextBtnSelector: string,
    perCardSetup: (card: ElementHandle<Element>) => Promise<void>,
    parseCard: (
      card: ElementHandle<Element>,
    ) => Promise<ScrapedProduct | null>,
  ): AsyncGenerator<ScrapedProduct> {
    let pageNum = 1;
    while (true) {
      console.log(`========== page ${pageNum} ==========`);
      const cards = await page.$$(productCardSelector);

      // Scroll each card into view to trigger lazy-loaded variant blocks.
      for (const card of cards) {
        await card.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const bottomY = rect.bottom + window.scrollY + 50;
          window.scrollTo({ top: bottomY, behavior: "smooth" });
        });
        await new Promise((r) => setTimeout(r, 100));
      }

      // Per-card setup (expand sizes, click "more", etc.) — supplied by subclass.
      for (let i = cards.length - 1; i >= 0; i--) {
        await cards[i].evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const bottomY = rect.bottom + window.scrollY + 50;
          window.scrollTo({ top: bottomY, behavior: "smooth" });
        });
        try {
          await perCardSetup(cards[i]);
        } catch (err) {
          console.warn("perCardSetup error:", err);
        }
      }

      // Parse + yield each card.
      for (let i = 0; i < cards.length; i++) {
        await cards[i].evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const bottomY = rect.bottom + window.scrollY + 50;
          window.scrollTo({ top: bottomY, behavior: "smooth" });
        });
        try {
          const product = await parseCard(cards[i]);
          if (product) yield product;
        } catch (err) {
          console.error(`parseCard error on card ${i + 1}:`, err);
        }
      }

      // Next page?
      let nextBtn: ElementHandle<Element> | null = null;
      try {
        nextBtn = await page.$(nextBtnSelector);
      } catch {
        nextBtn = null;
      }
      if (!nextBtn) {
        console.log("No more pages.");
        return;
      }
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: 30000,
        }),
        nextBtn.evaluate((el) => (el as HTMLElement).click()),
      ]);
      // If the cards never appear on the next page, treat it as end-of-pagination
      // rather than throwing. The next-link can lag the rendered list, and one
      // bad page used to kill the whole run (kajasport #82517985599 lost 33min).
      const ready = await page
        .waitForSelector(productCardSelector, { timeout: 30000 })
        .catch(() => null);
      if (!ready) {
        console.log(
          `No cards on page ${pageNum + 1} after "next" — treating as end of pagination.`,
        );
        return;
      }
      pageNum++;
    }
  }

  /**
   * Ensure the listing page-size ("portions") is `size` by choosing it in the
   * on-page dropdown — like a user would — rather than hitting settings.php with
   * a query param. The choice is client-side and persists for the session, so
   * this is a no-op (no interaction) on every page after the first, and only
   * re-applies if the value drifted.
   */
  protected async ensurePortions(
    page: Page,
    size: number,
    cardSelector: string,
  ): Promise<void> {
    const current = await page
      .$eval("#select_top_portions", (el) => (el as HTMLSelectElement).value)
      .catch(() => null);
    if (current === null || current === String(size)) return;

    // Prefer the visible dropdown item (native user gesture); fall back to
    // setting the underlying <select> and firing its change event.
    const item = await page.$(`.f-dropdown-item[data-value="${size}"]`);
    if (item) {
      const toggle = await page.$(
        ".s_paging__item.--portions .f-dropdown-toggle",
      );
      if (toggle) await toggle.click().catch(() => {});
      await item.evaluate((el) => (el as HTMLElement).click());
    } else {
      await page.$eval(
        "#select_top_portions",
        (el, v) => {
          const sel = el as HTMLSelectElement;
          sel.value = v as string;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        },
        String(size),
      );
    }

    // The list re-renders (full reload or AJAX). Settle, then confirm cards.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});
    await page.waitForSelector(cardSelector, { timeout: 30000 }).catch(() => {});
  }

  /** Collect per-colour-version metadata (id + fields the GraphQL API omits). */
  private async collectCardVersions(
    page: Page,
    cardSelector: string,
  ): Promise<CardVersion[]> {
    // NOTE: this callback is serialised into the page. Under tsx/esbuild, any
    // *named* inner function (`const f = () => …`) gets wrapped in a `__name(...)`
    // helper that doesn't exist in the browser — so keep everything inline and
    // anonymous here (no helper consts, no `.forEach` arrows).
    const versions = await page.$$eval(cardSelector, (cards) => {
      const out: {
        id: string;
        name: string | null;
        brand: string | null;
        image: string | null;
        href: string | null;
      }[] = [];
      for (const card of cards) {
        const nameEl = card.querySelector(".search_top__name_text");
        const name = nameEl?.textContent?.trim() ?? null;
        const brandEl = card.querySelector(
          ".search_top__param.--firm .search_top__param_value",
        );
        const brand = brandEl?.textContent?.trim() ?? null;
        const cardImg =
          (card.querySelector(".search_top__icon img") as HTMLImageElement | null)
            ?.src ?? null;
        const cardHref =
          (card.querySelector(".search_top__name") as HTMLAnchorElement | null)
            ?.href ?? null;
        const outerId = (card as HTMLElement).dataset.id ?? null;
        if (outerId)
          out.push({ id: outerId, name, brand, image: cardImg, href: cardHref });
        const blocks = card.querySelectorAll(
          ".search_versions__block[data-get-product]",
        );
        for (const b of blocks) {
          const id = (b as HTMLElement).dataset.getProduct;
          if (!id) continue;
          const bImg =
            (b.querySelector(".search_versions__label_gfx img") as HTMLImageElement | null)
              ?.src ?? cardImg;
          const bHref =
            (b.querySelector(".search_versions__label_text.--link") as HTMLAnchorElement | null)
              ?.href ?? cardHref;
          out.push({ id, name, brand, image: bImg, href: bHref });
        }
      }
      return out;
    });
    // Dedupe within the page, keeping the first (richest) metadata per id.
    const byId = new Map<string, CardVersion>();
    for (const v of versions) if (!byId.has(v.id)) byId.set(v.id, v);
    return [...byId.values()];
  }

  /**
   * Archetype D (IdoSell/IAI GraphQL): product ids come from the listing DOM,
   * variant data comes from replaying the site's native `POST /graphql/v1/`
   * request from inside the session. Colour (`Kolor`) and size (`Rozmiar`) are
   * cleanly separated by the API — no more generic `Wariant`.
   *
   * `seenIds` is run-scoped (shared across every category call) so we never
   * re-request a product from their API. A product recurring under another
   * category is yielded with no variants — the pipeline's idempotent product
   * upsert + `product_categories` link records the new category without a second
   * API call or duplicate snapshot.
   */
  protected async *paginateViaGraphql(
    page: Page,
    opts: {
      wholesalerId: string;
      cardSelector: string;
      nextBtnSelector: string;
      categoryPath: string[];
      portions: number;
      seenIds: Set<string>;
      getTemplate: () => QueryTemplate;
    },
  ): AsyncGenerator<ScrapedProduct> {
    const { wholesalerId, cardSelector, nextBtnSelector, categoryPath, seenIds } =
      opts;
    let pageNum = 1;
    while (true) {
      console.log(`========== page ${pageNum} ==========`);
      await this.ensurePortions(page, opts.portions, cardSelector);

      const versions = await this.collectCardVersions(page, cardSelector);
      const fresh = versions.filter((v) => !seenIds.has(v.id));
      const recurring = versions.filter((v) => seenIds.has(v.id));
      console.log(
        `[${wholesalerId}] page ${pageNum}: ${versions.length} versions ` +
          `(${fresh.length} new, ${recurring.length} recurring)`,
      );

      const freshById = new Map(fresh.map((v) => [v.id, v]));
      const chunks = chunkForBatches(fresh.map((v) => v.id));
      for (let c = 0; c < chunks.length; c++) {
        if (c > 0) await this.sleep(jitterMs());
        let nodes: Awaited<ReturnType<typeof fetchBatch>>;
        try {
          nodes = await fetchBatch(page, chunks[c], opts.getTemplate());
        } catch (err) {
          console.warn(`[${wholesalerId}] batch failed:`, err);
          continue;
        }
        for (const id of chunks[c]) {
          seenIds.add(id);
          const meta = freshById.get(id)!;
          const node = nodes.get(id);
          if (!node) {
            console.warn(`[${wholesalerId}] no GraphQL node for id ${id}`);
            continue;
          }
          yield {
            wholesalerId,
            symbol: id,
            name: meta.name ?? id,
            brand: meta.brand,
            image: meta.image,
            href: meta.href,
            categoryPath,
            variants: toScrapedVariants(node),
          };
        }
      }

      // Recurring products: category-link-only (no API call, no snapshots).
      for (const v of recurring) {
        yield {
          wholesalerId,
          symbol: v.id,
          name: v.name ?? v.id,
          brand: v.brand,
          image: v.image,
          href: v.href,
          categoryPath,
          variants: [],
        };
      }

      let nextBtn: ElementHandle<Element> | null = null;
      try {
        nextBtn = await page.$(nextBtnSelector);
      } catch {
        nextBtn = null;
      }
      if (!nextBtn) {
        console.log("No more pages.");
        return;
      }
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
        nextBtn.evaluate((el) => (el as HTMLElement).click()),
      ]);
      const ready = await page
        .waitForSelector(cardSelector, { timeout: 30000 })
        .catch(() => null);
      if (!ready) {
        console.log(
          `No cards on page ${pageNum + 1} after "next" — treating as end of pagination.`,
        );
        return;
      }
      pageNum++;
    }
  }

  /**
   * Archetype C: listing-page yields URLs, each URL opens a detail page,
   * parseDetail returns one ScrapedProduct per detail page.
   */
  protected async *iterateDetailPages(
    page: Page,
    listLinkSelector: string,
    hrefAttr: string,
    nextBtnSelector: string,
    parseDetail: (detailPage: Page) => Promise<ScrapedProduct | null>,
  ): AsyncGenerator<ScrapedProduct> {
    let pageNum = 1;
    while (true) {
      console.log(`========== listing page ${pageNum} ==========`);
      const urls = await page.$$eval(
        listLinkSelector,
        (els, attr) =>
          (els as HTMLElement[])
            .map((el) => el.getAttribute(attr as string))
            .filter((u): u is string => !!u),
        hrefAttr,
      );
      const listingUrl = page.url();

      for (const url of urls) {
        const absolute = new URL(url, listingUrl).href;
        try {
          await page.goto(absolute, { waitUntil: "domcontentloaded" });
          const product = await parseDetail(page);
          if (product) yield product;
        } catch (err) {
          console.error(`detail parse error for ${absolute}:`, err);
        }
      }

      await page.goto(listingUrl, { waitUntil: "domcontentloaded" });
      let nextBtn: ElementHandle<Element> | null = null;
      try {
        nextBtn = await page.$(nextBtnSelector);
      } catch {
        nextBtn = null;
      }
      if (!nextBtn) {
        console.log("No more pages.");
        return;
      }
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: 30000,
        }),
        nextBtn.evaluate((el) => (el as HTMLElement).click()),
      ]);
      pageNum++;
    }
  }

  /**
   * Archetype B: download a catalog file (XLSX/CSV) the wholesaler publishes.
   * Subclass parses the buffer (with xlsx, csv-parse, etc.) and yields products.
   */
  protected async fetchCatalogFile(
    url: string,
    init?: RequestInit,
  ): Promise<ArrayBuffer> {
    const res = await fetch(url, init);
    if (!res.ok)
      throw new Error(`fetchCatalogFile ${url}: ${res.status} ${res.statusText}`);
    return await res.arrayBuffer();
  }
}
