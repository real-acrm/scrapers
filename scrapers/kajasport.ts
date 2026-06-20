import "dotenv/config";
import { BaseScraper } from "./base.js";
import type { ScrapedProduct } from "../pipeline/types.js";
import {
  parseSearchListCard,
  toScrapedProduct,
  type RawProductCard,
} from "./lib/searchListCard.js";
import { extractSearchListNav } from "./lib/searchListNav.js";

export class KajasportScraper extends BaseScraper {
  readonly id = "kajasport";
  readonly displayName = "Kajasport (sport-hurtowo.pl)";
  readonly homeUrl = "https://www.sport-hurtowo.pl";

  async *scrape(): AsyncGenerator<ScrapedProduct> {
    const login = process.env.KAJA_LOGIN;
    const password = process.env.KAJA_PASSWORD;
    if (!login || !password)
      throw new Error("KAJA_LOGIN/KAJA_PASSWORD env vars required");

    const browser = await this.launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      );
      await page.setExtraHTTPHeaders({ "Accept-Language": "pl-PL,pl;q=0.9" });

      console.log("Navigating to login...");
      await page.goto(`${this.homeUrl}/login.php`, {
        waitUntil: "domcontentloaded",
      });
      // Cookie banner — try the "accept all" id, fall back to text-based click.
      await this.acceptCookies(page, "#acceptAll");
      try {
        await this.clickByText(page, "button", "Potwierdzam wszystkie");
      } catch {
        // banner already gone
      }
      await page.type('input[name="login"]', login);
      await page.type('input[name="password"]', password);
      await this.clickByText(page, "button", "Zaloguj się");
      await page.waitForSelector("li.nav-item");

      // Flip product listings to list view (the only layout that exposes the
      // markup the shared parser expects). settings.php persists the choice
      // for the session, so we only need to call it once.
      await page.goto(`${this.homeUrl}/settings.php?search_display_mode=list`, {
        waitUntil: "domcontentloaded",
      });

      const navs = await extractSearchListNav(page, "ODZIEŻ");

      for (const cat of navs) {
        // Some L2s (e.g. Dresy, Kurtki) have no L3 children — scrape them directly.
        const targets =
          cat.children.length > 0
            ? cat.children.map((c) => ({
                href: c.href,
                path: [cat.topCategory, cat.category, c.category],
                label: `${cat.topCategory} / ${cat.category} / ${c.category}`,
              }))
            : [
                {
                  href: cat.href,
                  path: [cat.topCategory, cat.category],
                  label: `${cat.topCategory} / ${cat.category}`,
                },
              ];
        for (const t of targets) {
          console.log(`[${this.id}] category ${t.label}`);
          await page.goto(`${t.href}?portions=300`, {
            waitUntil: "domcontentloaded",
          });
          await page.waitForSelector(".search_list__product", {
            timeout: 30000,
          });

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
                categoryPath: t.path,
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
