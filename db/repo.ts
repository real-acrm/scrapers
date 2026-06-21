import type { InStatement, InValue } from "@libsql/client";
import { getDb } from "./client.js";
import type { ScrapedProduct } from "../pipeline/types.js";

export async function upsertWholesaler(w: {
  id: string;
  name: string;
  url: string;
}): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO wholesalers (id, name, url) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url`,
    args: [w.id, w.name, w.url],
  });
}

export async function updateWholesalerLastScraped(
  wholesalerId: string,
  scrapedAt: string,
): Promise<void> {
  await getDb().execute({
    sql: `UPDATE wholesalers SET last_scraped_at = ? WHERE id = ?`,
    args: [scrapedAt, wholesalerId],
  });
}

export async function upsertBrand(
  wholesalerId: string,
  name: string,
): Promise<number> {
  const db = getDb();
  const ins = await db.execute({
    sql: `INSERT INTO brands (wholesaler_id, name) VALUES (?, ?)
          ON CONFLICT(wholesaler_id, name) DO NOTHING
          RETURNING id`,
    args: [wholesalerId, name],
  });
  if (ins.rows[0]) return Number(ins.rows[0].id);
  const sel = await db.execute({
    sql: `SELECT id FROM brands WHERE wholesaler_id = ? AND name = ?`,
    args: [wholesalerId, name],
  });
  return Number(sel.rows[0].id);
}

export async function upsertCategoryPath(
  wholesalerId: string,
  path: string[],
): Promise<number> {
  const db = getDb();
  let parentId: number | null = null;
  for (const name of path) {
    const insArgs: [string, number | null, string] = [wholesalerId, parentId, name];
    const ins = await db.execute({
      sql: `INSERT INTO categories (wholesaler_id, parent_id, name) VALUES (?, ?, ?)
            ON CONFLICT DO NOTHING RETURNING id`,
      args: insArgs,
    });
    if (ins.rows[0]) {
      parentId = Number(ins.rows[0].id);
      continue;
    }
    const selArgs: [string, number | null, string] = [wholesalerId, parentId, name];
    const sel = await db.execute({
      sql: `SELECT id FROM categories
            WHERE wholesaler_id = ? AND COALESCE(parent_id, 0) = COALESCE(?, 0) AND name = ?`,
      args: selArgs,
    });
    parentId = Number(sel.rows[0].id);
  }
  return parentId!;
}

export async function linkProductCategory(
  productId: number,
  categoryId: number,
): Promise<void> {
  await getDb().execute({
    sql: `INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)`,
    args: [productId, categoryId],
  });
}

export async function upsertProduct(p: {
  wholesalerId: string;
  symbol: string;
  name: string;
  brandId: number | null;
  categoryId: number | null;
  image: string | null;
  href: string | null;
  labels: string[];
}): Promise<number> {
  const now = new Date().toISOString();
  const rs = await getDb().execute({
    sql: `INSERT INTO products
            (wholesaler_id, symbol, name, brand_id, category_id, image, href, labels_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(wholesaler_id, symbol) DO UPDATE SET
            name        = excluded.name,
            brand_id    = excluded.brand_id,
            category_id = excluded.category_id,
            image       = excluded.image,
            href        = excluded.href,
            labels_json = excluded.labels_json,
            updated_at  = excluded.updated_at
          RETURNING id`,
    args: [
      p.wholesalerId,
      p.symbol,
      p.name,
      p.brandId,
      p.categoryId,
      p.image,
      p.href,
      JSON.stringify(p.labels),
      now,
    ],
  });
  return Number(rs.rows[0].id);
}

export async function upsertOptionAndValues(
  productId: number,
  optionName: string,
  values: string[],
): Promise<Map<string, number>> {
  const db = getDb();
  let optionId: number;
  const insOpt = await db.execute({
    sql: `INSERT INTO product_options (product_id, name) VALUES (?, ?)
          ON CONFLICT(product_id, name) DO NOTHING RETURNING id`,
    args: [productId, optionName],
  });
  if (insOpt.rows[0]) {
    optionId = Number(insOpt.rows[0].id);
  } else {
    const sel = await db.execute({
      sql: `SELECT id FROM product_options WHERE product_id = ? AND name = ?`,
      args: [productId, optionName],
    });
    optionId = Number(sel.rows[0].id);
  }

  for (const v of values) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO product_option_values (option_id, name) VALUES (?, ?)`,
      args: [optionId, v],
    });
  }

  const all = await db.execute({
    sql: `SELECT id, name FROM product_option_values WHERE option_id = ?`,
    args: [optionId],
  });
  const map = new Map<string, number>();
  for (const row of all.rows) map.set(String(row.name), Number(row.id));
  return map;
}

export async function upsertVariant(
  productId: number,
  optionValueIds: number[],
  sku?: string,
): Promise<number> {
  const db = getDb();

  // Resolve option name + value name per id, sort by option name for canonical key.
  const pairs: { optionName: string; valueName: string }[] = [];
  for (const id of optionValueIds) {
    const rs = await db.execute({
      sql: `SELECT po.name AS option_name, pov.name AS value_name
            FROM product_option_values pov
            JOIN product_options po ON po.id = pov.option_id
            WHERE pov.id = ?`,
      args: [id],
    });
    const row = rs.rows[0];
    pairs.push({
      optionName: String(row.option_name),
      valueName: String(row.value_name),
    });
  }
  pairs.sort((a, b) => a.optionName.localeCompare(b.optionName));
  const variantKey = pairs
    .map((p) => `${p.optionName}:${p.valueName}`)
    .join("|");

  let variantId: number;
  const ins = await db.execute({
    sql: `INSERT INTO variants (product_id, variant_key, sku) VALUES (?, ?, ?)
          ON CONFLICT(product_id, variant_key) DO NOTHING RETURNING id`,
    args: [productId, variantKey, sku ?? null],
  });
  if (ins.rows[0]) {
    variantId = Number(ins.rows[0].id);
  } else {
    const sel = await db.execute({
      sql: `SELECT id FROM variants WHERE product_id = ? AND variant_key = ?`,
      args: [productId, variantKey],
    });
    variantId = Number(sel.rows[0].id);
    if (sku) {
      await db.execute({
        sql: `UPDATE variants SET sku = ? WHERE id = ? AND (sku IS NULL OR sku <> ?)`,
        args: [sku, variantId, sku],
      });
    }
  }

  for (const ovId of optionValueIds) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO variant_option_values (variant_id, option_value_id) VALUES (?, ?)`,
      args: [variantId, ovId],
    });
  }
  return variantId;
}

// Returns the next batch of products for the daily detail trickle: variants
// missing a stock snapshot, or whose newest snapshot is older than `staleAfter`.
// Ordered oldest-stalest first so coverage stays roughly uniform.
export async function pickProductsForDetailRefresh(
  wholesalerId: string,
  limit: number,
  staleAfterIso: string,
): Promise<{ productId: number; href: string; symbol: string }[]> {
  const rs = await getDb().execute({
    sql: `
      WITH variant_latest AS (
        SELECT v.id AS variant_id, v.product_id, MAX(vs.scraped_at) AS last_at
        FROM variants v
        LEFT JOIN variant_snapshots vs ON vs.variant_id = v.id
        GROUP BY v.id, v.product_id
      ),
      product_oldest AS (
        SELECT product_id,
               MIN(COALESCE(last_at, '0')) AS oldest_at,
               SUM(CASE WHEN last_at IS NULL THEN 1 ELSE 0 END) AS missing
        FROM variant_latest
        GROUP BY product_id
      )
      SELECT p.id AS product_id, p.href, p.symbol
      FROM product_oldest po
      JOIN products p ON p.id = po.product_id
      WHERE p.wholesaler_id = ?
        AND p.href IS NOT NULL
        AND (po.missing > 0 OR po.oldest_at < ?)
      ORDER BY po.missing DESC, po.oldest_at ASC
      LIMIT ?`,
    args: [wholesalerId, staleAfterIso, limit],
  });
  return rs.rows.map((r) => ({
    productId: Number(r.product_id),
    href: String(r.href),
    symbol: String(r.symbol),
  }));
}

export async function findApiKey(
  key: string,
): Promise<{ id: number; revoked: boolean } | null> {
  const rs = await getDb().execute({
    sql: `SELECT id, revoked_at FROM api_keys WHERE key = ?`,
    args: [key],
  });
  const row = rs.rows[0];
  if (!row) return null;
  return { id: Number(row.id), revoked: row.revoked_at != null };
}

export async function markApiKeyUsed(id: number): Promise<void> {
  await getDb().execute({
    sql: `UPDATE api_keys SET last_used_at = ? WHERE id = ?`,
    args: [new Date().toISOString(), id],
  });
}

export async function createApiKey(args: {
  key: string;
  label: string;
}): Promise<number> {
  const rs = await getDb().execute({
    sql: `INSERT INTO api_keys (key, label, created_at) VALUES (?, ?, ?) RETURNING id`,
    args: [args.key, args.label, new Date().toISOString()],
  });
  return Number(rs.rows[0].id);
}

export async function listApiKeys(): Promise<
  {
    id: number;
    key: string;
    label: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }[]
> {
  const rs = await getDb().execute(
    `SELECT id, key, label, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id`,
  );
  return rs.rows.map((r) => ({
    id: Number(r.id),
    key: String(r.key),
    label: String(r.label),
    created_at: String(r.created_at),
    last_used_at: r.last_used_at == null ? null : String(r.last_used_at),
    revoked_at: r.revoked_at == null ? null : String(r.revoked_at),
  }));
}

export async function revokeApiKey(id: number): Promise<void> {
  await getDb().execute({
    sql: `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    args: [new Date().toISOString(), id],
  });
}

/**
 * Single-batch writer for the entire product graph (brand, categories,
 * product, options, variants, snapshots) using one libsql `db.batch`.
 *
 * All cross-statement IDs are resolved via subqueries on natural keys
 * (wholesaler_id+symbol, wholesaler_id+path, product_id+name, etc.) so the
 * whole graph commits in one HTTP roundtrip / one Turso transaction.
 *
 * Replaces the per-helper write path (upsertBrand → upsertCategoryPath →
 * upsertProduct → linkProductCategory → upsertOptionAndValues →
 * upsertVariant → insertSnapshot), which was ~10+ sequential roundtrips
 * per product and OOM'd Turso under matrix concurrency.
 */
export async function writeProductBatch(
  p: ScrapedProduct,
  scrapedAt: string,
): Promise<void> {
  const stmts: InStatement[] = [];
  const w = p.wholesalerId;
  const sym = p.symbol;

  // Subquery resolving the products row id by natural key.
  const productSubSql = `(SELECT id FROM products WHERE wholesaler_id = ? AND symbol = ?)`;
  const productSubArgs: InValue[] = [w, sym];

  // Subquery resolving the category id at depth k (1-indexed) of p.categoryPath.
  // For k=0 returns the SQL literal "NULL" with no args.
  const categoryIdAt = (k: number): { sql: string; args: InValue[] } => {
    if (k === 0) return { sql: "NULL", args: [] };
    if (k === 1) {
      return {
        sql: `(SELECT id FROM categories WHERE wholesaler_id = ? AND COALESCE(parent_id, 0) = 0 AND name = ?)`,
        args: [w, p.categoryPath[0]],
      };
    }
    const inner = categoryIdAt(k - 1);
    return {
      sql: `(SELECT id FROM categories WHERE wholesaler_id = ? AND COALESCE(parent_id, 0) = COALESCE(${inner.sql}, 0) AND name = ?)`,
      args: [w, ...inner.args, p.categoryPath[k - 1]],
    };
  };

  if (p.brand) {
    stmts.push({
      sql: `INSERT INTO brands (wholesaler_id, name) VALUES (?, ?)
            ON CONFLICT(wholesaler_id, name) DO NOTHING`,
      args: [w, p.brand],
    });
  }

  for (let i = 0; i < p.categoryPath.length; i++) {
    const parent = categoryIdAt(i);
    stmts.push({
      sql: `INSERT INTO categories (wholesaler_id, parent_id, name)
            VALUES (?, ${parent.sql}, ?)
            ON CONFLICT DO NOTHING`,
      args: [w, ...parent.args, p.categoryPath[i]],
    });
  }

  const brandSub = p.brand
    ? {
        sql: `(SELECT id FROM brands WHERE wholesaler_id = ? AND name = ?)`,
        args: [w, p.brand] as InValue[],
      }
    : { sql: `NULL`, args: [] as InValue[] };

  stmts.push({
    sql: `INSERT INTO products
            (wholesaler_id, symbol, name, brand_id, category_id, image, href, labels_json, updated_at)
          VALUES (?, ?, ?, ${brandSub.sql}, NULL, ?, ?, ?, ?)
          ON CONFLICT(wholesaler_id, symbol) DO UPDATE SET
            name        = excluded.name,
            brand_id    = excluded.brand_id,
            category_id = excluded.category_id,
            image       = excluded.image,
            href        = excluded.href,
            labels_json = excluded.labels_json,
            updated_at  = excluded.updated_at`,
    args: [
      w,
      sym,
      p.name,
      ...brandSub.args,
      p.image,
      p.href,
      JSON.stringify(p.labels),
      scrapedAt,
    ],
  });

  if (p.categoryPath.length > 0) {
    const leaf = categoryIdAt(p.categoryPath.length);
    stmts.push({
      sql: `INSERT OR IGNORE INTO product_categories (product_id, category_id)
            VALUES (${productSubSql}, ${leaf.sql})`,
      args: [...productSubArgs, ...leaf.args],
    });
  }

  // Distinct (optionName -> set of values) across all variants.
  const optionToValues = new Map<string, Set<string>>();
  for (const v of p.variants) {
    for (const ov of v.optionValues) {
      if (!optionToValues.has(ov.optionName))
        optionToValues.set(ov.optionName, new Set());
      optionToValues.get(ov.optionName)!.add(ov.value);
    }
  }

  for (const [optName, values] of optionToValues) {
    stmts.push({
      sql: `INSERT INTO product_options (product_id, name)
            VALUES (${productSubSql}, ?)
            ON CONFLICT(product_id, name) DO NOTHING`,
      args: [...productSubArgs, optName],
    });
    for (const valName of values) {
      stmts.push({
        sql: `INSERT INTO product_option_values (option_id, name)
              VALUES (
                (SELECT id FROM product_options WHERE product_id = ${productSubSql} AND name = ?),
                ?
              )
              ON CONFLICT(option_id, name) DO NOTHING`,
        args: [...productSubArgs, optName, valName],
      });
    }
  }

  for (const v of p.variants) {
    const pairs = v.optionValues
      .map((ov) => ({ optionName: ov.optionName, valueName: ov.value }))
      .sort((a, b) => a.optionName.localeCompare(b.optionName));
    const vkey = pairs.map((pp) => `${pp.optionName}:${pp.valueName}`).join("|");

    stmts.push({
      sql: `INSERT INTO variants (product_id, variant_key, sku)
            VALUES (${productSubSql}, ?, ?)
            ON CONFLICT(product_id, variant_key) DO UPDATE SET
              sku = COALESCE(excluded.sku, variants.sku)`,
      args: [...productSubArgs, vkey, v.sku ?? null],
    });

    const variantSubSql = `(SELECT id FROM variants WHERE product_id = ${productSubSql} AND variant_key = ?)`;
    const variantSubArgs: InValue[] = [...productSubArgs, vkey];

    for (const ov of v.optionValues) {
      stmts.push({
        sql: `INSERT OR IGNORE INTO variant_option_values (variant_id, option_value_id)
              VALUES (
                ${variantSubSql},
                (SELECT id FROM product_option_values
                   WHERE option_id = (SELECT id FROM product_options WHERE product_id = ${productSubSql} AND name = ?)
                     AND name = ?)
              )`,
        args: [
          ...variantSubArgs,
          ...productSubArgs,
          ov.optionName,
          ov.value,
        ],
      });
    }

    if (v.stock !== null) {
      stmts.push({
        sql: `INSERT INTO variant_snapshots
                (variant_id, wholesaler_id, scraped_at, price, lowest_price, regular_price, srp, currency, stock)
              VALUES (${variantSubSql}, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          ...variantSubArgs,
          w,
          scrapedAt,
          v.price,
          v.lowestPrice ?? null,
          v.regularPrice ?? null,
          v.srp ?? null,
          v.currency ?? null,
          v.stock,
        ],
      });
    }
  }

  await executeBatchWithBusyRetry(stmts);
}

// SQLite serializes writers. Around WAL checkpoints or transient lock spikes
// a batch can come back as SQLITE_BUSY even when overall load is fine; retry
// with exponential backoff so a single blip doesn't fail the whole scrape.
async function executeBatchWithBusyRetry(
  stmts: InStatement[],
): Promise<void> {
  const delays = [50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt++) {
    try {
      await getDb().batch(stmts, "write");
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "SQLITE_BUSY" || attempt >= delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

export async function insertSnapshot(s: {
  variantId: number;
  wholesalerId: string;
  scrapedAt: string;
  price: number | null;
  lowestPrice?: number;
  regularPrice?: number;
  srp?: number;
  currency?: string;
  stock: number;
}): Promise<void> {
  await getDb().execute({
    sql: `INSERT INTO variant_snapshots
            (variant_id, wholesaler_id, scraped_at, price, lowest_price, regular_price, srp, currency, stock)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      s.variantId,
      s.wholesalerId,
      s.scrapedAt,
      s.price,
      s.lowestPrice ?? null,
      s.regularPrice ?? null,
      s.srp ?? null,
      s.currency ?? null,
      s.stock,
    ],
  });
}
