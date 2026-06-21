import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import {
  brands,
  categories,
  productCategories,
  productOptionValues,
  productOptions,
  products,
  variantOptionValues,
  variantSnapshots,
  variants,
} from "./schema.js";
import type { ScrapedProduct } from "../pipeline/types.js";

/**
 * Persists an entire scraped product graph (brand, category path, product,
 * options, variants, snapshots) in a single ACID transaction.
 */
export async function writeProductBatch(
  p: ScrapedProduct,
  scrapedAt: string,
): Promise<void> {
  const db = getDb();
  const w = p.wholesalerId;

  await db.transaction(async (tx) => {
    // Brand
    let brandId: number | null = null;
    if (p.brand) {
      const brandName = p.brand;
      const inserted = await tx
        .insert(brands)
        .values({ wholesalerId: w, name: brandName })
        .onConflictDoUpdate({
          target: [brands.wholesalerId, brands.name],
          set: { name: sql`excluded.name` },
        })
        .returning({ id: brands.id });
      brandId = inserted[0].id;
    }

    // Category path — walk one level at a time, resolving each parent_id.
    // Conflict target is an expression index, so we can't name it via
    // onConflictDoUpdate's columns array; fall back to insert-then-select.
    let parentId: number | null = null;
    let leafCategoryId: number | null = null;
    for (const name of p.categoryPath) {
      const inserted = await tx
        .insert(categories)
        .values({ wholesalerId: w, parentId, name })
        .onConflictDoNothing()
        .returning({ id: categories.id });
      let id: number;
      if (inserted.length > 0) {
        id = inserted[0].id;
      } else {
        const capturedParent = parentId;
        const existing = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(
            and(
              eq(categories.wholesalerId, w),
              sql`COALESCE(${categories.parentId}, 0) = COALESCE(${capturedParent}::bigint, 0)`,
              eq(categories.name, name),
            ),
          )
          .limit(1);
        id = existing[0].id;
      }
      parentId = id;
      leafCategoryId = id;
    }

    // Product
    const productInsert = await tx
      .insert(products)
      .values({
        wholesalerId: w,
        symbol: p.symbol,
        name: p.name,
        brandId,
        categoryId: null,
        image: p.image,
        href: p.href,
        labelsJson: JSON.stringify(p.labels),
        updatedAt: scrapedAt,
      })
      .onConflictDoUpdate({
        target: [products.wholesalerId, products.symbol],
        set: {
          name: sql`excluded.name`,
          brandId: sql`excluded.brand_id`,
          categoryId: sql`excluded.category_id`,
          image: sql`excluded.image`,
          href: sql`excluded.href`,
          labelsJson: sql`excluded.labels_json`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ id: products.id });
    const productId = productInsert[0].id;

    if (leafCategoryId !== null) {
      await tx
        .insert(productCategories)
        .values({ productId, categoryId: leafCategoryId })
        .onConflictDoNothing();
    }

    // Distinct (optionName -> set of values) across all variants.
    const optionToValues = new Map<string, Set<string>>();
    for (const v of p.variants) {
      for (const ov of v.optionValues) {
        let set = optionToValues.get(ov.optionName);
        if (!set) {
          set = new Set();
          optionToValues.set(ov.optionName, set);
        }
        set.add(ov.value);
      }
    }

    // option_values_id by `${optionName}|${value}` for variant linking later.
    const valueIds = new Map<string, number>();
    for (const [optName, values] of optionToValues) {
      const optInsert = await tx
        .insert(productOptions)
        .values({ productId, name: optName })
        .onConflictDoUpdate({
          target: [productOptions.productId, productOptions.name],
          set: { name: sql`excluded.name` },
        })
        .returning({ id: productOptions.id });
      const optionId = optInsert[0].id;

      for (const valName of values) {
        const valInsert = await tx
          .insert(productOptionValues)
          .values({ optionId, name: valName })
          .onConflictDoUpdate({
            target: [productOptionValues.optionId, productOptionValues.name],
            set: { name: sql`excluded.name` },
          })
          .returning({ id: productOptionValues.id });
        valueIds.set(`${optName}|${valName}`, valInsert[0].id);
      }
    }

    // Variants + variant_option_values + snapshots
    for (const v of p.variants) {
      const pairs = v.optionValues
        .map((ov) => ({ optionName: ov.optionName, valueName: ov.value }))
        .sort((a, b) => a.optionName.localeCompare(b.optionName));
      const variantKey = pairs
        .map((pp) => `${pp.optionName}:${pp.valueName}`)
        .join("|");

      const variantInsert = await tx
        .insert(variants)
        .values({ productId, variantKey, sku: v.sku ?? null })
        .onConflictDoUpdate({
          target: [variants.productId, variants.variantKey],
          set: { sku: sql`COALESCE(excluded.sku, ${variants.sku})` },
        })
        .returning({ id: variants.id });
      const variantId = variantInsert[0].id;

      for (const ov of v.optionValues) {
        const ovId = valueIds.get(`${ov.optionName}|${ov.value}`);
        if (ovId === undefined) continue;
        await tx
          .insert(variantOptionValues)
          .values({ variantId, optionValueId: ovId })
          .onConflictDoNothing();
      }

      if (v.stock !== null) {
        await tx.insert(variantSnapshots).values({
          variantId,
          wholesalerId: w,
          scrapedAt,
          price: v.price,
          lowestPrice: v.lowestPrice ?? null,
          regularPrice: v.regularPrice ?? null,
          srp: v.srp ?? null,
          currency: v.currency ?? null,
          stock: v.stock,
        });
      }
    }
  });
}
