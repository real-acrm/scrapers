import "dotenv/config";
import { BaseScraper } from "./base.js";
import type { ScrapedProduct } from "../pipeline/types.js";
import { createTemplateCapturer } from "./lib/graphqlVariants.js";
import { extractSearchListNav } from "./lib/searchListNav.js";

const CARD = ".search_list__product";
const NEXT =
  "li.pagination__element.--next:not(.--disabled) a.pagination__link";

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
    // Run-scoped: never re-request a product from their API within one run.
    const seenIds = new Set<string>();
    try {
      const page = await browser.newPage();
      // Clone the site's own /graphql/v1/ query shape from its first native request.
      const capturer = createTemplateCapturer(page);
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      );
      await page.setExtraHTTPHeaders({ "Accept-Language": "pl-PL,pl;q=0.9" });

      console.log("Navigating to login...");
      await page.goto(`${this.homeUrl}/login.php`, {
        waitUntil: "domcontentloaded",
      });
      await this.sleep(5000);

      // Cookie banner — try the "accept all" id, fall back to text-based click.
      await this.acceptCookies(page, "#acceptAll");
      try {
        await this.clickByText(page, "button", "Potwierdzam wszystkie");
      } catch {
        // banner already gone
      }
      await this.sleep(2000);

      await page.type('input[name="login"]', login);
      await this.sleep(1000);
      await page.type('input[name="password"]', password);
      await this.sleep(1000);
      await this.clickByText(page, "button", "Zaloguj się");
      // Give the form-submit navigation room to complete before the next goto;
      // `li.nav-item` matches pre-login too, so a fixed wait is more reliable.
      await this.sleep(5000);

      // Flip product listings to list view (the only layout that exposes the
      // markup the shared parser expects). settings.php persists the choice
      // for the session, so we only need to call it once.
      await page.goto(`${this.homeUrl}/settings.php?search_display_mode=list`, {
        waitUntil: "domcontentloaded",
      });
      await this.sleep(2000);
      // Page size (portions=300) is chosen on-page via the dropdown by
      // ensurePortions() on the first category page; it persists for the session.

      const topCategories = [
        "ODZIEŻ",
        "DYSCYPLINY",
        "BAGAŻ",
        "WYPOSAŻENIE BOISK",
        "REKREACJA",
        "SIŁOWNIA I FITNESS",
        "TROFEA",
      ];
      const navs: Awaited<ReturnType<typeof extractSearchListNav>> = [];
      for (const label of topCategories) {
        try {
          const sub = await extractSearchListNav(page, label);
          console.log(
            `[${this.id}] ${sub.length} subcategories under ${label}`,
          );
          navs.push(...sub);
        } catch (err) {
          console.warn(
            `[${this.id}] failed to extract nav for ${label}: ${(err as Error).message}`,
          );
        }
      }
      const totalTargets = navs.reduce(
        (n, c) => n + (c.children.length > 0 ? c.children.length : 1),
        0,
      );
      console.log(
        `[${this.id}] ${navs.length} L2 categories total, ${totalTargets} leaf targets`,
      );

      let targetIdx = 0;
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
          targetIdx++;
          console.log(
            `[${this.id}] -> category "${t.label}" (${targetIdx}/${totalTargets})`,
          );
          await page.goto(t.href, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(CARD, { timeout: 30000 });

          yield* this.paginateViaGraphql(page, {
            wholesalerId: this.id,
            cardSelector: CARD,
            nextBtnSelector: NEXT,
            categoryPath: t.path,
            portions: 300,
            seenIds,
            getTemplate: () => capturer.get(),
          });
        }
      }
    } finally {
      await browser.close();
    }
  }
}
