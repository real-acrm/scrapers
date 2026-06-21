import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, ElementHandle, Page } from "puppeteer";
import type { ScrapedProduct } from "../pipeline/types.js";

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
    return puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1280, height: 900 },
      args: ["--no-sandbox"],
    }) as unknown as Promise<Browser>;
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
