import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { wholesalers } from "../db/schema.js";
import { writeScrapedProduct } from "./normalize.js";
import type { BaseScraper } from "../scrapers/base.js";

// One write = one ACID transaction in Postgres. 4 concurrent workers is plenty
// for the scraper write path; bump WRITE_CONCURRENCY if a specific scraper needs more.
const WRITE_CONCURRENCY = Number(process.env.WRITE_CONCURRENCY ?? "4");

export async function runScrapers(scrapers: BaseScraper[]): Promise<void> {
  const db = getDb();
  const failed: string[] = [];
  for (const s of scrapers) {
    console.log(`[${s.id}] starting`);
    await db
      .insert(wholesalers)
      .values({ id: s.id, name: s.displayName, url: s.homeUrl })
      .onConflictDoUpdate({
        target: wholesalers.id,
        set: { name: s.displayName, url: s.homeUrl },
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
      await db
        .update(wholesalers)
        .set({ lastScrapedAt: scrapedAt })
        .where(eq(wholesalers.id, s.id));
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
