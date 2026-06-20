import "dotenv/config";
import { runScrapers } from "./pipeline/run.js";
import { NaleoScraper } from "./scrapers/naleo.js";
import { KajasportScraper } from "./scrapers/kajasport.js";
import { GoldensneakersScraper } from "./scrapers/goldensneakers.js";
import { BrandsdistributionScraper } from "./scrapers/brandsdistribution.js";
import { BrandsgatewayScraper } from "./scrapers/brandsgateway.js";

runScrapers([
  new NaleoScraper(),
  new KajasportScraper(),
  new GoldensneakersScraper(),
  new BrandsdistributionScraper(),
  new BrandsgatewayScraper(),
])
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
