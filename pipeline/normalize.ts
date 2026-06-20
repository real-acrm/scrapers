import * as repo from "../db/repo.js";
import type { ScrapedProduct } from "./types.js";

export async function writeScrapedProduct(
  p: ScrapedProduct,
  scrapedAt: string,
): Promise<void> {
  const brandId = p.brand
    ? await repo.upsertBrand(p.wholesalerId, p.brand)
    : null;
  const categoryId = p.categoryPath.length
    ? await repo.upsertCategoryPath(p.wholesalerId, p.categoryPath)
    : null;

  const productId = await repo.upsertProduct({
    wholesalerId: p.wholesalerId,
    symbol: p.symbol,
    name: p.name,
    brandId,
    categoryId: null,
    image: p.image,
    href: p.href,
    labels: p.labels,
  });

  if (categoryId !== null) {
    await repo.linkProductCategory(productId, categoryId);
  }

  const optionToValues = new Map<string, Set<string>>();
  for (const v of p.variants) {
    for (const ov of v.optionValues) {
      if (!optionToValues.has(ov.optionName))
        optionToValues.set(ov.optionName, new Set());
      optionToValues.get(ov.optionName)!.add(ov.value);
    }
  }

  const lookup = new Map<string, Map<string, number>>();
  for (const [optionName, values] of optionToValues) {
    lookup.set(
      optionName,
      await repo.upsertOptionAndValues(productId, optionName, [...values]),
    );
  }

  for (const v of p.variants) {
    const ids = v.optionValues.map(
      (ov) => lookup.get(ov.optionName)!.get(ov.value)!,
    );
    const variantId = await repo.upsertVariant(productId, ids, v.sku);
    // brandsgateway's Meilisearch payload tells us which variants exist but
    // not their per-size stock. We upsert the variant row so the trickle can
    // find it, and skip the snapshot until the detail page fills in stock.
    if (v.stock === null) continue;
    await repo.insertSnapshot({
      variantId,
      wholesalerId: p.wholesalerId,
      scrapedAt,
      price: v.price,
      lowestPrice: v.lowestPrice,
      regularPrice: v.regularPrice,
      srp: v.srp,
      currency: v.currency,
      stock: v.stock,
    });
  }
}
