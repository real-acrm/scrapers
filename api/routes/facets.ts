import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
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
// excluded from the context. "Nike (42)" means "with the rest of the filters
// applied but brand cleared, 42 products are Nike". Each facet runs its own
// query with the relevant field stripped from the ProductsQuery.
facets.openapi(route, async (c) => {
  const q = c.req.valid("query");
  const db = getDb();

  const without = (overrides: Partial<ProductsQuery>): ProductsQuery => ({
    ...q,
    ...overrides,
  });

  const wholesalerQ = without({ wholesaler: undefined });
  const brandQ = without({ brand: undefined });
  const categoryQ = without({ category: undefined });
  const inStockQ = without({ in_stock: undefined });
  const onPromoQ = without({ on_promo: undefined });
  const priceQ = without({ min_price: undefined, max_price: undefined });

  const wholesalerCte = buildFilteredBase(wholesalerQ, false);
  const brandCte = buildFilteredBase(brandQ, false);
  const categoryCte = buildFilteredBase(categoryQ, false);
  const inStockCte = buildFilteredBase(inStockQ, false);
  const onPromoCte = buildFilteredBase(onPromoQ, false);
  const priceCte = buildFilteredBase(priceQ, false);

  const wholesalerSql = `${wholesalerCte.cte}
    SELECT f.wholesaler_id AS id, w.name AS name, COUNT(*) AS count
    FROM filtered f LEFT JOIN wholesalers w ON w.id = f.wholesaler_id
    GROUP BY f.wholesaler_id, w.name
    ORDER BY count DESC, name ASC`;

  const brandSql = `${brandCte.cte}
    SELECT brand AS value, brand AS label, COUNT(*) AS count
    FROM filtered
    WHERE brand IS NOT NULL
    GROUP BY brand
    ORDER BY count DESC, brand ASC`;

  const categorySql = `${categoryCte.cte}
    SELECT f.category_id AS value, c.name AS label, COUNT(*) AS count
    FROM filtered f LEFT JOIN categories c ON c.id = f.category_id
    WHERE f.category_id IS NOT NULL
    GROUP BY f.category_id, c.name
    ORDER BY count DESC, label ASC`;

  const inStockSql = `${inStockCte.cte}
    SELECT
      SUM(CASE WHEN any_in_stock = 1 THEN 1 ELSE 0 END) AS true_count,
      SUM(CASE WHEN any_in_stock = 0 THEN 1 ELSE 0 END) AS false_count
    FROM filtered`;

  const onPromoSql = `${onPromoCte.cte}
    SELECT
      SUM(CASE WHEN max_discount > 0 THEN 1 ELSE 0 END) AS true_count,
      SUM(CASE WHEN max_discount IS NULL OR max_discount = 0 THEN 1 ELSE 0 END) AS false_count
    FROM filtered`;

  const priceSql = `${priceCte.cte}
    SELECT MIN(min_price) AS price_min, MAX(min_price) AS price_max
    FROM filtered`;

  const [wRs, bRs, cRs, sRs, pRs, prRs] = await Promise.all([
    db.execute({ sql: wholesalerSql, args: wholesalerCte.args }),
    db.execute({ sql: brandSql, args: brandCte.args }),
    db.execute({ sql: categorySql, args: categoryCte.args }),
    db.execute({ sql: inStockSql, args: inStockCte.args }),
    db.execute({ sql: onPromoSql, args: onPromoCte.args }),
    db.execute({ sql: priceSql, args: priceCte.args }),
  ]);

  const wholesaler = wRs.rows.map((r) => ({
    id: String(r.id),
    name: r.name == null ? String(r.id) : String(r.name),
    count: Number(r.count),
  }));
  const brand = bRs.rows.map((r) => ({
    value: String(r.value),
    label: String(r.label),
    count: Number(r.count),
  }));
  const category = cRs.rows.map((r) => ({
    value: String(r.value),
    label: r.label == null ? String(r.value) : String(r.label),
    count: Number(r.count),
  }));
  const s = sRs.rows[0] ?? {};
  const p = pRs.rows[0] ?? {};
  const pr = prRs.rows[0] ?? {};
  return c.json(
    {
      wholesaler,
      brand,
      category,
      in_stock: {
        true: Number(s.true_count ?? 0),
        false: Number(s.false_count ?? 0),
      },
      on_promo: {
        true: Number(p.true_count ?? 0),
        false: Number(p.false_count ?? 0),
      },
      price: {
        min: pr.price_min == null ? 0 : Number(pr.price_min),
        max: pr.price_max == null ? 0 : Number(pr.price_max),
      },
    },
    200,
  );
});
