import "dotenv/config";
import { Buy2beeScraper } from "../scrapers/buy2bee.js";

const scraper = new Buy2beeScraper();
let n = 0;
const LIMIT = 5;
for await (const p of scraper.scrape()) {
  n++;
  console.log(
    JSON.stringify(
      {
        n,
        symbol: p.symbol,
        brand: p.brand,
        name: p.name,
        categoryPath: p.categoryPath,
        href: p.href,
        variants: p.variants.length,
        firstVariant: p.variants[0],
      },
      null,
      2,
    ),
  );
  if (n >= LIMIT) {
    console.log(`\n[verify] got ${LIMIT} products — stopping.`);
    process.exit(0);
  }
}
console.log(`[verify] generator finished with ${n} products.`);
process.exit(0);
