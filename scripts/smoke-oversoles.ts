/**
 * Ad-hoc smoke runner: opens a real Chrome with the persistent oversoles
 * profile, walks a couple of catalogue pages, prints products to stdout,
 * and exits. No DB writes. Use this to verify the scraper end-to-end
 * before wiring it into the cron / DB pipeline.
 *
 *   npm run scrape -- (uses index.ts which writes to DB)
 *   tsx scripts/smoke-oversoles.ts 3   (this script, dry-run 3 pages)
 */
import { OversolesScraper } from "../scrapers/oversoles.js";

const MAX_PAGES = Number(process.argv[2] ?? "2");
const PRODUCTS_PER_PAGE = 24;

async function main() {
  const scraper = new (class extends OversolesScraper {
    async *scrape() {
      let n = 0;
      const inner = OversolesScraper.prototype.scrape.call(this);
      for await (const p of inner) {
        n++;
        console.log(
          `\n#${n} ${p.brand ?? "?"} | ${p.name} | symbol=${p.symbol}`,
        );
        console.log(`   href=${p.href}`);
        console.log(`   img=${p.image}`);
        for (const v of p.variants) {
          console.log(
            `   size=${v.optionValues[0]?.value}  sku=${v.sku}  price=${v.price}${v.currency}  stock=${v.stock}`,
          );
        }
        if (n >= MAX_PAGES * PRODUCTS_PER_PAGE) break;
      }
    }
  })();
  for await (const _ of scraper.scrape()) {
    // generator already logs
  }
  console.log("\n[smoke-oversoles] done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
