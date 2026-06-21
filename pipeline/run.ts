import { migrate } from "../db/migrate.js";
import {
  upsertWholesaler,
  updateWholesalerLastScraped,
} from "../db/repo.js";
import { writeScrapedProduct } from "./normalize.js";
import type { BaseScraper } from "../scrapers/base.js";

// Each "write" is one libsql batch = one Turso transaction = one HTTP
// roundtrip (see repo.writeProductBatch). So WRITE_CONCURRENCY=16 means up to
// 16 concurrent Turso transactions, not ~160 in-flight statements like before
// the batch refactor — which is what kept blowing Turso's per-DB memory.
// Upserts are idempotent (ON CONFLICT) so concurrent writes can't collide.
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
