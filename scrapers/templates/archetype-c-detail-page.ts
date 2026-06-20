import "dotenv/config";
import type { Page } from "puppeteer";
import { BaseScraper } from "../base.js";
import type { ScrapedProduct } from "../../pipeline/types.js";

/**
 * ARCHETYPE C — detail-page scraper.
 *
 * Use when: the listing page only gives product URLs (or shows incomplete data
 * like missing stock/variants). You must open each product's detail page to
 * harvest the full ScrapedProduct.
 *
 * Memory stays constant — one detail page is open at a time.
 *
 * Steps to adapt for a new wholesaler:
 *   1. Set id / displayName / homeUrl.
 *   2. Fill in login + per-category listing-page navigation.
 *   3. Provide the listing-link selector and pagination selector.
 *   4. Implement parseDetail (runs in the product detail page).
 */
export class ArchetypeCDetailPageTemplate extends BaseScraper {
  readonly id = "TODO_wholesaler_id";
  readonly displayName = "TODO Display Name";
  readonly homeUrl = "https://TODO";

  async *scrape(): AsyncGenerator<ScrapedProduct> {
    const login = process.env.LOGIN;
    const password = process.env.PASSWORD;
    if (!login || !password)
      throw new Error("LOGIN/PASSWORD env vars required");

    const browser = await this.launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      );

      // TODO: login flow
      await page.goto(`${this.homeUrl}/TODO_LOGIN_PATH`, {
        waitUntil: "domcontentloaded",
      });
      await this.acceptCookies(page, "TODO_COOKIE_BANNER_SELECTOR");
      await page.type("TODO_LOGIN_INPUT_SELECTOR", login);
      await page.type("TODO_PASSWORD_INPUT_SELECTOR", password);
      await this.clickByText(page, "button", "TODO_SUBMIT_BUTTON_TEXT");

      // TODO: list of category listing pages to walk
      const listingPages: { categoryPath: string[]; url: string }[] = [];

      for (const cat of listingPages) {
        await page.goto(cat.url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("TODO_PRODUCT_LINK_SELECTOR");

        yield* this.iterateDetailPages(
          page,
          "TODO_PRODUCT_LINK_SELECTOR",
          "href",
          "TODO_PAGINATION_NEXT_SELECTOR",
          async (detailPage) => {
            return await this.parseDetail(detailPage, cat.categoryPath);
          },
        );
      }
    } finally {
      await browser.close();
    }
  }

  private async parseDetail(
    page: Page,
    categoryPath: string[],
  ): Promise<ScrapedProduct | null> {
    // TODO: wait for detail-page selectors, then page.evaluate(...) to harvest fields.
    void page;
    void categoryPath;
    return null;
  }
}
