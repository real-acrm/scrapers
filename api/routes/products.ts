import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { InValue } from "@libsql/client";
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

function buildList(q: ListQuery, forceDeals: boolean) {
  const where: string[] = [];
  const args: InValue[] = [];
  if (q.wholesaler) {
    where.push("p.wholesaler_id = ?");
    args.push(q.wholesaler);
  }
  if (q.brand) {
    where.push("b.name = ?");
    args.push(q.brand);
  }
  if (q.category !== undefined) {
    where.push("p.category_id = ?");
    args.push(q.category);
  }
  if (q.q) {
    where.push("p.name LIKE ?");
    args.push(`%${q.q}%`);
  }

  const having: string[] = [];
  if (q.in_stock === true) having.push("any_in_stock = 1");
  if (q.on_promo === true) having.push("max_discount > 0");
  if (q.min_price !== undefined) {
    having.push("min_price >= ?");
    args.push(q.min_price);
  }
  if (q.max_price !== undefined) {
    having.push("min_price <= ?");
    args.push(q.max_price);
  }
  if (forceDeals) having.push("max_discount > 0");

  const sort = forceDeals ? "discount_desc" : q.sort;
  const orderBy = {
    newest: "updated_at DESC",
    price_asc: "min_price ASC NULLS LAST",
    price_desc: "min_price DESC NULLS LAST",
    discount_desc: "max_discount DESC NULLS LAST",
  }[sort];

  // CTE: latest snapshot per variant via row_number window, then aggregate per product.
  const sql = `
    WITH latest AS (
      SELECT vs.variant_id, vs.price, vs.regular_price, vs.currency, vs.stock,
             CASE WHEN vs.regular_price IS NOT NULL AND vs.price IS NOT NULL AND vs.regular_price > vs.price
                  THEN ROUND((vs.regular_price - vs.price) * 100.0 / vs.regular_price, 1)
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
             b.name AS brand,
             COALESCE(a.min_price, NULL) AS min_price,
             COALESCE(a.currency, NULL) AS currency,
             COALESCE(a.any_in_stock, 0) AS any_in_stock,
             a.max_discount
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN agg a ON a.product_id = p.id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
    )
    SELECT *, COUNT(*) OVER () AS total_count FROM base
    ${having.length ? "WHERE " + having.join(" AND ") : ""}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?`;

  args.push(q.pageSize, (q.page - 1) * q.pageSize);
  return { sql, args };
}

products.openapi(listRoute, async (c) => {
  const q = c.req.valid("query");
  const { sql, args } = buildList(q, false);
  const rs = await getDb().execute({ sql, args });
  const total = rs.rows[0] ? Number(rs.rows[0].total_count) : 0;
  const items = rs.rows.map((r) => ({
    id: Number(r.id),
    wholesaler_id: String(r.wholesaler_id),
    symbol: String(r.symbol),
    name: String(r.name),
    brand: r.brand == null ? null : String(r.brand),
    image: r.image == null ? null : String(r.image),
    href: r.href == null ? null : String(r.href),
    min_price: r.min_price == null ? null : Number(r.min_price),
    currency: r.currency == null ? null : String(r.currency),
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

export { buildList };

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

  const productRs = await db.execute({
    sql: `SELECT p.id, p.wholesaler_id, p.symbol, p.name, p.image, p.href,
                 p.category_id, p.labels_json, p.updated_at, b.name AS brand
          FROM products p LEFT JOIN brands b ON b.id = p.brand_id
          WHERE p.id = ?`,
    args: [id],
  });
  const p = productRs.rows[0];
  if (!p) return c.json({ error: "not found" }, 404);

  const variantRs = await db.execute({
    sql: `
      SELECT v.id AS variant_id, v.variant_key, v.sku,
             (SELECT json_group_array(json_object('option', po.name, 'value', pov.name))
                FROM variant_option_values vov
                JOIN product_option_values pov ON pov.id = vov.option_value_id
                JOIN product_options po ON po.id = pov.option_id
                WHERE vov.variant_id = v.id) AS option_values,
             (SELECT json_object('scraped_at', vs.scraped_at, 'price', vs.price,
                                 'lowest_price', vs.lowest_price, 'regular_price', vs.regular_price, 'stock', vs.stock)
                FROM variant_snapshots vs
                WHERE vs.variant_id = v.id
                ORDER BY vs.scraped_at DESC LIMIT 1) AS latest_snapshot
      FROM variants v WHERE v.product_id = ?`,
    args: [id],
  });

  const variants = variantRs.rows.map((r) => ({
    variant_id: Number(r.variant_id),
    variant_key: String(r.variant_key),
    sku: r.sku == null ? null : String(r.sku),
    option_values: r.option_values ? JSON.parse(String(r.option_values)) : [],
    latest_snapshot: r.latest_snapshot
      ? JSON.parse(String(r.latest_snapshot))
      : null,
  }));

  // Aggregate min_price/discount/in_stock from variant snapshots for parity with list view.
  let min_price: number | null = null;
  let currency: string | null = null;
  let in_stock = false;
  let max_discount: number | null = null;
  for (const v of variants) {
    const s = v.latest_snapshot as
      | {
          price: number | null;
          regular_price: number | null;
          stock: number;
        }
      | null;
    if (!s) continue;
    if (s.stock > 0) in_stock = true;
    if (s.price != null && (min_price == null || s.price < min_price))
      min_price = s.price;
    if (s.regular_price != null && s.price != null && s.regular_price > s.price) {
      const d =
        Math.round(((s.regular_price - s.price) * 100.0) / s.regular_price * 10) /
        10;
      if (max_discount == null || d > max_discount) max_discount = d;
    }
  }

  return c.json(
    {
      id: Number(p.id),
      wholesaler_id: String(p.wholesaler_id),
      symbol: String(p.symbol),
      name: String(p.name),
      brand: p.brand == null ? null : String(p.brand),
      image: p.image == null ? null : String(p.image),
      href: p.href == null ? null : String(p.href),
      category_id: p.category_id == null ? null : Number(p.category_id),
      labels: p.labels_json ? JSON.parse(String(p.labels_json)) : [],
      updated_at: String(p.updated_at),
      min_price,
      currency,
      in_stock,
      discount_percent: max_discount,
      variants,
    },
    200,
  );
});
