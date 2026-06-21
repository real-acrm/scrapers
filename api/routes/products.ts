import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
  PaginatedSchema,
  ProductDetailSchema,
  ProductListItemSchema,
  ProductsQuerySchema,
} from "../schemas.js";

export const products = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["products"],
  request: { query: ProductsQuerySchema },
  responses: {
    200: {
      description: "Paginated product list",
      content: {
        "application/json": {
          schema: PaginatedSchema(ProductListItemSchema),
        },
      },
    },
  },
});

type ListQuery = z.infer<typeof ProductsQuerySchema>;

type FilteredRow = {
  id: number;
  wholesaler_id: string;
  symbol: string;
  name: string;
  image: string | null;
  href: string | null;
  updated_at: string;
  category_id: number | null;
  brand: string | null;
  min_price: number | null;
  currency: string | null;
  any_in_stock: number;
  max_discount: number | null;
};

/**
 * Builds the CTE chain producing `filtered` rows (per product) after product-
 * level WHEREs and aggregate-level HAVINGs. Reused by /products list and /facets.
 */
export function buildFilteredBase(
  q: ListQuery,
  forceDeals: boolean,
): { cte: SQL } {
  const composedWhere: SQL[] = [];
  if (q.wholesaler) composedWhere.push(sql`p.wholesaler_id = ${q.wholesaler}`);
  if (q.brand && q.brand.length > 0) {
    composedWhere.push(
      sql`b.name IN (${sql.join(
        q.brand.map((v) => sql`${v}`),
        sql`, `,
      )})`,
    );
  }
  if (q.category && q.category.length > 0) {
    composedWhere.push(
      sql`EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id IN (${sql.join(
        q.category.map((v) => sql`${v}`),
        sql`, `,
      )}))`,
    );
  }
  if (q.q) composedWhere.push(sql`p.name ILIKE ${"%" + q.q + "%"}`);

  const having: SQL[] = [];
  if (q.in_stock === true) having.push(sql`any_in_stock = 1`);
  if (q.in_stock === false) having.push(sql`any_in_stock = 0`);
  if (q.on_promo === true) having.push(sql`max_discount > 0`);
  if (q.on_promo === false)
    having.push(sql`(max_discount IS NULL OR max_discount = 0)`);
  if (q.min_price !== undefined)
    having.push(sql`min_price >= ${q.min_price}`);
  if (q.max_price !== undefined)
    having.push(sql`min_price <= ${q.max_price}`);
  if (forceDeals) having.push(sql`max_discount > 0`);

  const whereSql =
    composedWhere.length > 0
      ? sql` WHERE ${sql.join(composedWhere, sql` AND `)}`
      : sql``;
  const havingSql =
    having.length > 0 ? sql` WHERE ${sql.join(having, sql` AND `)}` : sql``;

  const cte = sql`
    WITH latest AS (
      SELECT vs.variant_id, vs.price, vs.regular_price, vs.currency, vs.stock,
             CASE WHEN vs.regular_price IS NOT NULL AND vs.price IS NOT NULL AND vs.regular_price > vs.price
                  THEN ROUND(((vs.regular_price - vs.price) * 100.0 / vs.regular_price)::numeric, 1)
                  ELSE NULL END AS discount_percent,
             ROW_NUMBER() OVER (PARTITION BY vs.variant_id ORDER BY vs.scraped_at DESC) AS rn
      FROM variant_snapshots vs
    ),
    agg AS (
      SELECT v.product_id,
             MIN(l.price) AS min_price,
             MAX(CASE WHEN l.stock > 0 THEN 1 ELSE 0 END) AS any_in_stock,
             MAX(l.discount_percent) AS max_discount,
             MAX(l.currency) AS currency
      FROM variants v
      LEFT JOIN latest l ON l.variant_id = v.id AND l.rn = 1
      GROUP BY v.product_id
    ),
    base AS (
      SELECT p.id, p.wholesaler_id, p.symbol, p.name, p.image, p.href,
             p.updated_at AS updated_at,
             p.category_id,
             b.name AS brand,
             a.min_price AS min_price,
             a.currency AS currency,
             COALESCE(a.any_in_stock, 0) AS any_in_stock,
             a.max_discount
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN agg a ON a.product_id = p.id
      ${whereSql}
    ),
    filtered AS (
      SELECT * FROM base${havingSql}
    )`;

  return { cte };
}

products.openapi(listRoute, async (c) => {
  const q = c.req.valid("query");
  const { cte } = buildFilteredBase(q, false);

  const orderBy = {
    newest: sql`updated_at DESC`,
    price_asc: sql`min_price ASC NULLS LAST`,
    price_desc: sql`min_price DESC NULLS LAST`,
    discount_desc: sql`max_discount DESC NULLS LAST`,
  }[q.sort];

  const offset = (q.page - 1) * q.pageSize;
  const stmt = sql`${cte}
    SELECT *, COUNT(*) OVER () AS total_count FROM filtered
    ORDER BY ${orderBy}
    LIMIT ${q.pageSize} OFFSET ${offset}`;

  const result = await getDb().execute<FilteredRow & { total_count: number }>(
    stmt,
  );
  const rows = result.rows;
  const total = rows[0] ? Number(rows[0].total_count) : 0;
  const items = rows.map((r) => ({
    id: Number(r.id),
    wholesaler_id: r.wholesaler_id,
    symbol: r.symbol,
    name: r.name,
    brand: r.brand,
    image: r.image,
    href: r.href,
    min_price: r.min_price == null ? null : Number(r.min_price),
    currency: r.currency,
    in_stock: Number(r.any_in_stock) === 1,
    discount_percent: r.max_discount == null ? null : Number(r.max_discount),
  }));
  return c.json(
    {
      items,
      page: q.page,
      pageSize: q.pageSize,
      total,
      hasMore: q.page * q.pageSize < total,
    },
    200,
  );
});

const detailRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["products"],
  request: { params: z.object({ id: z.coerce.number().int() }) },
  responses: {
    200: {
      description: "Product detail",
      content: { "application/json": { schema: ProductDetailSchema } },
    },
    404: { description: "Not found" },
  },
});

products.openapi(detailRoute, async (c) => {
  const { id } = c.req.valid("param");
  const db = getDb();

  const product = await db.query.products.findFirst({
    where: (p, { eq }) => eq(p.id, id),
    with: {
      brand: { columns: { name: true } },
      productCategories: {
        columns: { categoryId: true },
        limit: 1,
      },
      variants: {
        with: {
          snapshots: {
            orderBy: (s, { desc }) => desc(s.scrapedAt),
            limit: 1,
          },
          optionValues: {
            with: {
              optionValue: {
                with: { option: { columns: { name: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (!product) return c.json({ error: "not found" }, 404);

  const variantOut = product.variants.map((v) => ({
    variant_id: v.id,
    variant_key: v.variantKey,
    sku: v.sku,
    option_values: v.optionValues.map((vov) => ({
      option: vov.optionValue.option.name,
      value: vov.optionValue.name,
    })),
    latest_snapshot:
      v.snapshots[0] == null
        ? null
        : {
            scraped_at: v.snapshots[0].scrapedAt,
            price: v.snapshots[0].price,
            lowest_price: v.snapshots[0].lowestPrice,
            regular_price: v.snapshots[0].regularPrice,
            stock: v.snapshots[0].stock,
          },
  }));

  let min_price: number | null = null;
  let in_stock = false;
  let max_discount: number | null = null;
  for (const v of variantOut) {
    const s = v.latest_snapshot;
    if (!s) continue;
    if (s.stock > 0) in_stock = true;
    if (s.price != null && (min_price == null || s.price < min_price))
      min_price = s.price;
    if (
      s.regular_price != null &&
      s.price != null &&
      s.regular_price > s.price
    ) {
      const d =
        Math.round(
          (((s.regular_price - s.price) * 100.0) / s.regular_price) * 10,
        ) / 10;
      if (max_discount == null || d > max_discount) max_discount = d;
    }
  }

  return c.json(
    {
      id: product.id,
      wholesaler_id: product.wholesalerId,
      symbol: product.symbol,
      name: product.name,
      brand: product.brand?.name ?? null,
      image: product.image,
      href: product.href,
      category_id:
        product.categoryId ?? product.productCategories[0]?.categoryId ?? null,
      labels: product.labelsJson ? JSON.parse(product.labelsJson) : [],
      updated_at: product.updatedAt,
      min_price,
      currency: null,
      in_stock,
      discount_percent: max_discount,
      variants: variantOut,
    },
    200,
  );
});
