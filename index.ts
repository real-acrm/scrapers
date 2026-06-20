import "dotenv/config";
import { runScrapers } from "./pipeline/run.js";
import { NaleoScraper } from "./scrapers/naleo.js";
import { KajasportScraper } from "./scrapers/kajasport.js";
import { GoldensneakersScraper } from "./scrapers/goldensneakers.js";
import { BrandsdistributionScraper } from "./scrapers/brandsdistribution.js";
import { BrandsgatewayScraper } from "./scrapers/brandsgateway.js";
import { Buy2beeScraper } from "./scrapers/buy2bee.js";
import type { BaseScraper } from "./scrapers/base.js";

const ALL: BaseScraper[] = [
  new NaleoScraper(),
  new KajasportScraper(),
  new GoldensneakersScraper(),
  new BrandsdistributionScraper(),
  new BrandsgatewayScraper(),
  new Buy2beeScraper(),
];

// Pick subset via CLI arg or SCRAPER env. Accepts comma-separated ids.
// Examples: `npm run scrape -- naleo`, `SCRAPER=naleo,kajasport npm run scrape`.
const arg = process.argv[2] ?? process.env.SCRAPER ?? "";
const wanted = arg
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const selected = wanted.length === 0
  ? ALL
  : ALL.filter((s) => wanted.includes(s.id));

if (wanted.length > 0 && selected.length === 0) {
  console.error(
    `no scrapers matched "${arg}". available: ${ALL.map((s) => s.id).join(", ")}`,
  );
  process.exit(2);
}

runScrapers(selected)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
