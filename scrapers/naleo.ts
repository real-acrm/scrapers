import "dotenv/config";
import { BaseScraper } from "./base.js";
import type { ScrapedProduct } from "../pipeline/types.js";
import {
  parseSearchListCard,
  toScrapedProduct,
  type RawProductCard,
} from "./lib/searchListCard.js";
import { extractSearchListNav } from "./lib/searchListNav.js";

export class NaleoScraper extends BaseScraper {
  readonly id = "naleo";
  readonly displayName = "B2B Naleo";
  readonly homeUrl = "https://b2b-naleo.pl";

  async *scrape(): AsyncGenerator<ScrapedProduct> {
    const login = process.env.NALEO_LOGIN;
    const password = process.env.NALEO_PASSWORD;
    if (!login || !password)
      throw new Error("NALEO_LOGIN/NALEO_PASSWORD env vars required");

    const browser = await this.launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      );
      await page.setExtraHTTPHeaders({ "Accept-Language": "pl-PL,pl;q=0.9" });

      console.log("Navigating to login...");
      await page.goto(`${this.homeUrl}/index.php`, {
        waitUntil: "domcontentloaded",
      });
      await this.acceptCookies(page, "#acceptAll");
      await page.type('input[name="login"]', login);
      await page.type('input[name="password"]', password);
      await this.clickByText(page, "button", "Log in");
      await page.waitForSelector("li.nav-item");

      const sections = ["Kobieta", "Mężczyzna", "Dziecko", "Akcesoria"];
      console.log(`[${this.id}] ${sections.length} top categories: ${sections.join(", ")}`);
      const navs = [];
      for (const label of sections) {
        navs.push(...(await extractSearchListNav(page, label)));
      }
      const totalLeaves = navs.reduce((n, c) => n + c.children.length, 0);
      console.log(`[${this.id}] ${navs.length} subcategories, ${totalLeaves} leaf categories`);

      let leafIdx = 0;
      for (const cat of navs) {
        for (const child of cat.children) {
          leafIdx++;
          console.log(
            `[${this.id}] -> category "${cat.topCategory} > ${cat.category} > ${child.category}" (${leafIdx}/${totalLeaves})`,
          );
          await page.goto(`${child.href}?portions=300`, {
            waitUntil: "domcontentloaded",
          });
          const ready = await page
            .waitForSelector(".search_list__product", { timeout: 30000 })
            .catch(() => null);
          if (!ready) {
            // Empty leaf category (or selector renamed). Skip it instead of
            // killing the whole run — naleo run #82517834651 lost 1h13m of
            // progress when a single leaf had no cards.
            console.warn(
              `[${this.id}] no products on "${cat.topCategory} > ${cat.category} > ${child.category}"; skipping leaf`,
            );
            continue;
          }

          yield* this.paginateAndYield(
            page,
            ".search_list__product",
            "li.pagination__element.--next:not(.--disabled) a.pagination__link",
            async (card) => {
              const expand = await card.$("span.search_versions_toggle__show");
              if (expand && (await expand.isVisible())) await expand.click();
              await this.waitForNetworkIdle(page, "/graphql/v1/");
              const more = await card.$("a[href='#moreSizes']");
              if (more && (await more.isVisible())) await more.click();
            },
            async (card) => {
              const raw = (await card.evaluate(
                parseSearchListCard,
              )) as RawProductCard | null;
              if (!raw || !raw.symbol || !raw.title) return null;
              return toScrapedProduct(raw, {
                wholesalerId: this.id,
                categoryPath: [
                  cat.topCategory,
                  cat.category,
                  child.category,
                ],
              });
            },
          );
        }
      }
    } finally {
      await browser.close();
    }
  }
}
