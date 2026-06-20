import "dotenv/config";
import type { Page } from "puppeteer";
import { BaseScraper } from "../base.js";
import type { ScrapedProduct, ScrapedVariant } from "../../pipeline/types.js";

/**
 * ARCHETYPE A — listing-card scraper.
 *
 * Use when: product cards on the category listing page already contain everything
 * you need (price, stock, variants). Pagination walks through pages of cards.
 *
 * Reference impl: scrapers/naleo.ts
 *
 * Steps to adapt for a new wholesaler:
 *   1. Set id / displayName / homeUrl below.
 *   2. Fill in login + category-nav extraction in scrape().
 *   3. Replace the selectors in paginateAndYield(...).
 *   4. Rewrite parseProductCard (runs in browser) and toScrapedProduct.
 *   5. Register an instance in index.ts.
 */
export class ArchetypeAListingCardTemplate extends BaseScraper {
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
      await page.setExtraHTTPHeaders({ "Accept-Language": "pl-PL,pl;q=0.9" });

      // TODO: navigate to login page + cookie consent
      await page.goto(`${this.homeUrl}/TODO_LOGIN_PATH`, {
        waitUntil: "domcontentloaded",
      });
      await this.acceptCookies(page, "TODO_COOKIE_BANNER_SELECTOR");

      // TODO: login form
      await page.type("TODO_LOGIN_INPUT_SELECTOR", login);
      await page.type("TODO_PASSWORD_INPUT_SELECTOR", password);
      await this.clickByText(page, "button", "TODO_SUBMIT_BUTTON_TEXT");

      // TODO: extract category nav (return list of leaf category pages to scrape)
      const categories: { categoryPath: string[]; url: string }[] =
        await this.extractCategories(page);

      for (const cat of categories) {
        await page.goto(cat.url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("TODO_PRODUCT_CARD_SELECTOR", {
          timeout: 30000,
        });

        yield* this.paginateAndYield(
          page,
          "TODO_PRODUCT_CARD_SELECTOR",
          "TODO_PAGINATION_NEXT_SELECTOR",
          async (card) => {
            // TODO: per-card expand/lazy-load (click "more sizes", wait for XHR, etc.)
            void card;
          },
          async (card) => {
            const raw = await card.evaluate(parseProductCard);
            if (!raw) return null;
            return toScrapedProduct(raw, {
              wholesalerId: this.id,
              categoryPath: cat.categoryPath,
            });
          },
        );
      }
    } finally {
      await browser.close();
    }
  }

  private async extractCategories(
    page: Page,
  ): Promise<{ categoryPath: string[]; url: string }[]> {
    // TODO: implement nav extraction. Should return one entry per leaf category.
    void page;
    return [];
  }
}

type RawProduct = {
  title: string;
  symbol: string;
  brand: string | null;
  image: string | null;
  href: string | null;
  labels: string[];
  variants: {
    optionValues: { optionName: string; value: string }[];
    price: number | null;
    stock: number;
  }[];
};

/** Runs in browser context via card.evaluate. TODO: implement. */
function parseProductCard(card: Element): RawProduct | null {
  void card;
  return null;
}

function toScrapedProduct(
  raw: RawProduct,
  ctx: { wholesalerId: string; categoryPath: string[] },
): ScrapedProduct {
  const variants: ScrapedVariant[] = raw.variants.map((v) => ({
    optionValues: v.optionValues,
    price: v.price,
    stock: v.stock,
  }));
  return {
    wholesalerId: ctx.wholesalerId,
    symbol: raw.symbol,
    name: raw.title,
    brand: raw.brand,
    image: raw.image,
    href: raw.href,
    labels: raw.labels,
    categoryPath: ctx.categoryPath,
    variants,
  };
}
