import { migrate } from "../db/migrate.js";
import {
  upsertWholesaler,
  updateWholesalerLastScraped,
} from "../db/repo.js";
import { writeScrapedProduct } from "./normalize.js";
import type { BaseScraper } from "../scrapers/base.js";

export async function runScrapers(scrapers: BaseScraper[]): Promise<void> {
  await migrate();
  for (const s of scrapers) {
    console.log(`[${s.id}] starting`);
    await upsertWholesaler({
      id: s.id,
      name: s.displayName,
      url: s.homeUrl,
    });
    const scrapedAt = new Date().toISOString();
    let count = 0;
    try {
      for await (const product of s.scrape()) {
        await writeScrapedProduct(product, scrapedAt);
        count++;
        if (count % 50 === 0)
          console.log(`[${s.id}] ${count} products written`);
      }
      await updateWholesalerLastScraped(s.id, scrapedAt);
      console.log(`[${s.id}] done, ${count} products`);
    } catch (err) {
      console.error(`[${s.id}] failed after ${count} products:`, err);
    }
  }
}
