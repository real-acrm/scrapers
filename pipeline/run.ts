import { migrate } from "../db/migrate.js";
import {
  upsertWholesaler,
  updateWholesalerLastScraped,
} from "../db/repo.js";
import { writeScrapedProduct } from "./normalize.js";
import type { BaseScraper } from "../scrapers/base.js";

// brandsgateway's Meilisearch pull returns ~55k hits in ~1s but each Turso
// roundtrip serializes ~200ms, so a sequential writer pins throughput at ~2/sec
// and the GHA 6h cap kills the job at ~52k. Overlapping the writes via a small
// pool turns the same job into a ~5min run. Safe for the other scrapers too —
// the upserts are idempotent (ON CONFLICT) so concurrent writes can't collide.
const WRITE_CONCURRENCY = Number(process.env.WRITE_CONCURRENCY ?? "16");

export async function runScrapers(scrapers: BaseScraper[]): Promise<void> {
  await migrate();
  const failed: string[] = [];
  for (const s of scrapers) {
    console.log(`[${s.id}] starting`);
    await upsertWholesaler({
      id: s.id,
      name: s.displayName,
      url: s.homeUrl,
    });
    const scrapedAt = new Date().toISOString();
    let count = 0;
    let writeErr: unknown = null;
    const inFlight = new Set<Promise<void>>();
    try {
      for await (const product of s.scrape()) {
        if (writeErr) throw writeErr;
        const task: Promise<void> = writeScrapedProduct(product, scrapedAt)
          .then(() => {
            count++;
            if (count % 50 === 0)
              console.log(`[${s.id}] ${count} products written`);
          })
          .catch((err: unknown) => {
            if (!writeErr) writeErr = err;
          })
          .finally(() => {
            inFlight.delete(task);
          });
        inFlight.add(task);
        if (inFlight.size >= WRITE_CONCURRENCY) {
          await Promise.race(inFlight);
        }
      }
      await Promise.all(inFlight);
      if (writeErr) throw writeErr;
      await updateWholesalerLastScraped(s.id, scrapedAt);
      console.log(`[${s.id}] done, ${count} products`);
    } catch (err) {
      await Promise.allSettled(inFlight);
      console.error(`[${s.id}] failed after ${count} products:`, err);
      failed.push(s.id);
    }
  }
  if (failed.length > 0) {
    throw new Error(`scrapers failed: ${failed.join(", ")}`);
  }
}
