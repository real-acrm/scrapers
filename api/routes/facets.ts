import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
  FacetsSchema,
  ProductsQuerySchema,
  type ProductsQuery,
} from "../schemas.js";
import { buildFilteredBase } from "./products.js";

export const facets = new OpenAPIHono();

const route = createRoute({
  method: "get",
  path: "/",
  tags: ["facets"],
  request: { query: ProductsQuerySchema },
  responses: {
    200: {
      description: "Filter facet counts over the current filter context",
      content: { "application/json": { schema: FacetsSchema } },
    },
  },
});

// True faceting: when counting a given facet, that facet's own filter is
// excluded from the context. "Nike (42)" means: with the rest of the filters
// applied but brand cleared, 42 products are Nike. Each facet runs its own
// query with the relevant field stripped.
facets.openapi(route, async (c) => {
  const q = c.req.valid("query");
  const db = getDb();

  const without = (overrides: Partial<ProductsQuery>): ProductsQuery => ({
    ...q,
    ...overrides,
  });

  const ws = buildFilteredBase(without({ wholesaler: undefined }), false);
  const bs = buildFilteredBase(without({ brand: undefined }), false);
  const cs = buildFilteredBase(without({ category: undefined }), false);
  const ins = buildFilteredBase(without({ in_stock: undefined }), false);
  const ps = buildFilteredBase(without({ on_promo: undefined }), false);
  const prs = buildFilteredBase(
    without({ min_price: undefined, max_price: undefined }),
    false,
  );

  const [wRs, bRs, cRs, sRs, pRs, prRs] = await Promise.all([
    db.execute<{ id: string; name: string | null; count: number }>(sql`
      ${ws.cte}
      SELECT f.wholesaler_id AS id, w.name AS name, COUNT(*)::int AS count
      FROM filtered f LEFT JOIN wholesalers w ON w.id = f.wholesaler_id
      GROUP BY f.wholesaler_id, w.name
      ORDER BY count DESC, name ASC
    `),
    db.execute<{ value: string; label: string; count: number }>(sql`
      ${bs.cte}
      SELECT brand AS value, brand AS label, COUNT(*)::int AS count
      FROM filtered
      WHERE brand IS NOT NULL
      GROUP BY brand
      ORDER BY count DESC, brand ASC
    `),
    db.execute<{ value: number; label: string | null; count: number }>(sql`
      ${cs.cte}
      SELECT pc.category_id AS value, c.name AS label, COUNT(*)::int AS count
      FROM filtered f
      JOIN product_categories pc ON pc.product_id = f.id
      LEFT JOIN categories c ON c.id = pc.category_id
      GROUP BY pc.category_id, c.name
      ORDER BY count DESC, label ASC
    `),
    db.execute<{ true_count: number | null; false_count: number | null }>(sql`
      ${ins.cte}
      SELECT
        SUM(CASE WHEN any_in_stock = 1 THEN 1 ELSE 0 END)::int AS true_count,
        SUM(CASE WHEN any_in_stock = 0 THEN 1 ELSE 0 END)::int AS false_count
      FROM filtered
    `),
    db.execute<{ true_count: number | null; false_count: number | null }>(sql`
      ${ps.cte}
      SELECT
        SUM(CASE WHEN max_discount > 0 THEN 1 ELSE 0 END)::int AS true_count,
        SUM(CASE WHEN max_discount IS NULL OR max_discount = 0 THEN 1 ELSE 0 END)::int AS false_count
      FROM filtered
    `),
    db.execute<{ price_min: number | null; price_max: number | null }>(sql`
      ${prs.cte}
      SELECT MIN(min_price)::float AS price_min, MAX(min_price)::float AS price_max
      FROM filtered
    `),
  ]);

  return c.json(
    {
      wholesaler: wRs.rows.map((r) => ({
        id: r.id,
        name: r.name ?? r.id,
        count: r.count,
      })),
      brand: bRs.rows.map((r) => ({
        value: r.value,
        label: r.label,
        count: r.count,
      })),
      category: cRs.rows.map((r) => ({
        value: String(r.value),
        label: r.label ?? String(r.value),
        count: r.count,
      })),
      in_stock: {
        true: sRs.rows[0]?.true_count ?? 0,
        false: sRs.rows[0]?.false_count ?? 0,
      },
      on_promo: {
        true: pRs.rows[0]?.true_count ?? 0,
        false: pRs.rows[0]?.false_count ?? 0,
      },
      price: {
        min: prRs.rows[0]?.price_min ?? 0,
        max: prRs.rows[0]?.price_max ?? 0,
      },
    },
    200,
  );
});
