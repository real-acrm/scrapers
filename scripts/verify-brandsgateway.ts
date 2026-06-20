import "dotenv/config";
import { BrandsgatewayScraper } from "../scrapers/brandsgateway.js";

const scraper = new BrandsgatewayScraper();
const LIMIT = 5;
let n = 0;
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
        labels: p.labels,
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
