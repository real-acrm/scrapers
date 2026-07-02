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
   * Ensure the listing shows as many products per page as possible, by choosing
   * the **largest available** "portions" option in the page's own on-page
   * dropdown — like a user would.
   *
   * Verified against the live site (Playwright audit, 2026-07):
   * - `#select_top_portions` is a *hidden, inert* native <select> wrapped in a
   *   custom `.f-dropdown` widget: a `.f-dropdown-toggle` button + a
   *   `<ul.f-dropdown-menu>` of `<a.f-dropdown-item data-value="N">`. Setting the
   *   <select>'s value or dispatching `change` only updates the visual label —
   *   it does NOT reload. Selection happens by **clicking the menu item**, and
   *   the list re-renders via **AJAX (no navigation)**.
   * - The option set is **per-category**: a small category caps below 300 (e.g.
   *   210), a large one goes up to 300. So we target the largest option present,
   *   never a hardcoded 300.
   * - The dropdown is absent entirely when a category is too small to paginate —
   *   that means everything is already shown, so skip.
   *
   * `size` is treated as an upper cap (defaults to 300); we pick the largest
   * option ≤ `size`. Called on every listing page — the choice does NOT persist
   * across categories (each fresh category resets to its default ~30).
   */
  protected async ensurePortions(
    page: Page,
    size: number,
    cardSelector: string,
  ): Promise<void> {
    // Inspect the widget: present? largest option ≤ cap? already selected?
    const state = await page.evaluate(
      (cap, cardSel) => {
        const sel = document.querySelector(
          "#select_top_portions",
        ) as HTMLSelectElement | null;
        const cards = document.querySelectorAll(cardSel).length;
        if (!sel) return { present: false, largest: 0, atLargest: true, cards };
        const values = [...sel.options]
          .map((o) => Number(o.value))
          .filter((n) => !Number.isNaN(n) && n <= cap);
        const largest = values.length ? Math.max(...values) : 0;
        return {
          present: true,
          largest,
          atLargest: largest === 0 || Number(sel.value) === largest,
          cards,
        };
      },
      size,
      cardSelector,
    );

    if (!state.present || state.atLargest) return;

    const before = state.cards;
    // Click the largest menu item. The handler is delegated, so a click lands
    // even with the menu closed; we open the toggle first anyway, user-like.
    await page.evaluate((largest) => {
      const sel = document.querySelector("#select_top_portions");
      const widget = sel ? sel.closest(".f-dropdown") : null;
      if (!widget) return;
      const toggle = widget.querySelector(".f-dropdown-toggle");
      if (toggle) (toggle as HTMLElement).click();
      const item = widget.querySelector(
        `.f-dropdown-item[data-value="${largest}"]`,
      );
      if (item) (item as HTMLElement).click();
    }, state.largest);

    // AJAX re-render (no navigation): wait for the network to settle and the
    // card count to grow past what was shown before.
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 20000 }).catch(() => {});
    await page
      .waitForFunction(
        (sel, n) => document.querySelectorAll(sel as string).length > (n as number),
        { timeout: 20000 },
        cardSelector,
        before,
      )
      .catch(() => {});
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
        // Pace before every batch (incl. the first on a page) — simulate a user
        // scrolling and letting products load into view, not machine-gunning.
        await this.sleep(jitterMs());
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
