import { and, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "./client.js";
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

// Neon adapters expose `.batch([...])` for one-roundtrip multi-statement
// pipelining. PGlite (tests) doesn't — fall back to sequential awaits there.
async function runBatch(db: Db, queries: unknown[]): Promise<unknown[]> {
  if (queries.length === 0) return [];
  const maybeBatch = (db as unknown as { batch?: (qs: unknown[]) => Promise<unknown[]> })
    .batch;
  if (typeof maybeBatch === "function") {
    return maybeBatch.call(db, queries);
  }
  const results: unknown[] = [];
  for (const q of queries) {
    results.push(await (q as Promise<unknown>));
  }
  return results;
}

export async function writeProductBatch(
  p: ScrapedProduct,
  scrapedAt: string,
): Promise<void> {
  const db = getDb();
  const w = p.wholesalerId;

  // Phase 1: brand
  let brandId: number | null = null;
  if (p.brand) {
    const r = await db
      .insert(brands)
      .values({ wholesalerId: w, name: p.brand })
      .onConflictDoUpdate({
        target: [brands.wholesalerId, brands.name],
        set: { name: sql`excluded.name` },
      })
      .returning({ id: brands.id });
    brandId = r[0].id;
  }

  // Phase 2: categories walk — sequential, each level needs prev parent_id.
  let parentId: number | null = null;
  let leafCategoryId: number | null = null;
  for (const name of p.categoryPath) {
    const inserted = await db
      .insert(categories)
      .values({ wholesalerId: w, parentId, name })
      .onConflictDoNothing()
      .returning({ id: categories.id });
    let id: number;
    if (inserted.length > 0) {
      id = inserted[0].id;
    } else {
      const captured = parentId;
      const existing = await db
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(
            eq(categories.wholesalerId, w),
            sql`COALESCE(${categories.parentId}, 0) = COALESCE(${captured}::bigint, 0)`,
            eq(categories.name, name),
          ),
        )
        .limit(1);
      id = existing[0].id;
    }
    parentId = id;
    leafCategoryId = id;
  }

  // Phase 3: product upsert
  const prodR = await db
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
  const productId = prodR[0].id;

  // Distinct (option -> values) across all variants.
  const optionToValues = new Map<string, Set<string>>();
  for (const v of p.variants) {
    for (const ov of v.optionValues) {
      let s = optionToValues.get(ov.optionName);
      if (!s) {
        s = new Set();
        optionToValues.set(ov.optionName, s);
      }
      s.add(ov.value);
    }
  }
  const optionNames = [...optionToValues.keys()];

  // Phase 4: product_categories link + product_options multi-row (batched).
  const phase4Queries: unknown[] = [];
  const linkPresent = leafCategoryId !== null;
  if (linkPresent) {
    phase4Queries.push(
      db
        .insert(productCategories)
        .values({ productId, categoryId: leafCategoryId! })
        .onConflictDoNothing(),
    );
  }
  const optionsPresent = optionNames.length > 0;
  if (optionsPresent) {
    phase4Queries.push(
      db
        .insert(productOptions)
        .values(optionNames.map((name) => ({ productId, name })))
        .onConflictDoUpdate({
          target: [productOptions.productId, productOptions.name],
          set: { name: sql`excluded.name` },
        })
        .returning({ id: productOptions.id, name: productOptions.name }),
    );
  }
  const phase4Results = await runBatch(db, phase4Queries);
  const optionIdByName = new Map<string, number>();
  if (optionsPresent) {
    const optRows = phase4Results[
      phase4Results.length - 1
    ] as Array<{ id: number; name: string }>;
    for (const r of optRows) optionIdByName.set(r.name, r.id);
  }

  // Phase 5: product_option_values multi-row.
  const valueIdByKey = new Map<string, number>();
  if (optionToValues.size > 0) {
    const valueRows: { optionId: number; name: string }[] = [];
    for (const [optName, values] of optionToValues) {
      const optionId = optionIdByName.get(optName)!;
      for (const valName of values) valueRows.push({ optionId, name: valName });
    }
    const inserted = await db
      .insert(productOptionValues)
      .values(valueRows)
      .onConflictDoUpdate({
        target: [productOptionValues.optionId, productOptionValues.name],
        set: { name: sql`excluded.name` },
      })
      .returning({
        id: productOptionValues.id,
        optionId: productOptionValues.optionId,
        name: productOptionValues.name,
      });
    const optionNameById = new Map<number, string>();
    for (const [name, id] of optionIdByName) optionNameById.set(id, name);
    for (const r of inserted) {
      const optName = optionNameById.get(r.optionId)!;
      valueIdByKey.set(`${optName}|${r.name}`, r.id);
    }
  }

  // Phase 6: variants multi-row.
  const variantInputs = p.variants.map((v) => {
    const pairs = v.optionValues
      .map((ov) => ({ optionName: ov.optionName, valueName: ov.value }))
      .sort((a, b) => a.optionName.localeCompare(b.optionName));
    const variantKey = pairs
      .map((pp) => `${pp.optionName}:${pp.valueName}`)
      .join("|");
    return { variant: v, variantKey };
  });
  const variantIdByKey = new Map<string, number>();
  if (variantInputs.length > 0) {
    const inserted = await db
      .insert(variants)
      .values(
        variantInputs.map(({ variant, variantKey }) => ({
          productId,
          variantKey,
          sku: variant.sku ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [variants.productId, variants.variantKey],
        set: { sku: sql`COALESCE(excluded.sku, ${variants.sku})` },
      })
      .returning({ id: variants.id, variantKey: variants.variantKey });
    for (const r of inserted) variantIdByKey.set(r.variantKey, r.id);
  }

  // Phase 7: variant_option_values + variant_snapshots (batched).
  const vovRows: { variantId: number; optionValueId: number }[] = [];
  for (const { variant, variantKey } of variantInputs) {
    const variantId = variantIdByKey.get(variantKey)!;
    for (const ov of variant.optionValues) {
      const ovId = valueIdByKey.get(`${ov.optionName}|${ov.value}`);
      if (ovId === undefined) continue;
      vovRows.push({ variantId, optionValueId: ovId });
    }
  }
  const snapshotRows = variantInputs
    .filter(({ variant }) => variant.stock !== null)
    .map(({ variant, variantKey }) => ({
      variantId: variantIdByKey.get(variantKey)!,
      wholesalerId: w,
      scrapedAt,
      price: variant.price,
      lowestPrice: variant.lowestPrice ?? null,
      regularPrice: variant.regularPrice ?? null,
      srp: variant.srp ?? null,
      currency: variant.currency ?? null,
      stock: variant.stock!,
    }));

  const phase7Queries: unknown[] = [];
  if (vovRows.length > 0) {
    phase7Queries.push(
      db.insert(variantOptionValues).values(vovRows).onConflictDoNothing(),
    );
  }
  if (snapshotRows.length > 0) {
    phase7Queries.push(db.insert(variantSnapshots).values(snapshotRows));
  }
  await runBatch(db, phase7Queries);
}
