import * as repo from "../db/repo.js";
import type { ScrapedProduct } from "./types.js";

export async function writeScrapedProduct(
  p: ScrapedProduct,
  scrapedAt: string,
): Promise<void> {
  await repo.writeProductBatch(p, scrapedAt);
}
