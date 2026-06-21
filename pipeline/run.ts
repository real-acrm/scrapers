import { migrate } from "../db/migrate.js";
import {
  upsertWholesaler,
  updateWholesalerLastScraped,
} from "../db/repo.js";
import { writeScrapedProduct } from "./normalize.js";
import type { BaseScraper } from "../scrapers/base.js";

// Each "write" is one libsql batch = one short write transaction at sqld.
// SQLite serializes writers, so high concurrency just queues on the write
// lock and risks SQLITE_BUSY around WAL checkpoints. Since each batch is one
// HTTP roundtrip (~30-80ms vs ~2s in the pre-batch days), a small pool is
// plenty: 4 workers comfortably saturate the single-writer pipeline without
// fighting the lock. Override via env if a specific scraper needs more.
const WRITE_CONCURRENCY = Number(process.env.WRITE_CONCURRENCY ?? "4");

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
