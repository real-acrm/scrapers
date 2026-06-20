import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb } from "../../db/client.js";
import { HistoryRowSchema } from "../schemas.js";

export const snapshots = new OpenAPIHono();

const historyRoute = createRoute({
  method: "get",
  path: "/{id}/history",
  tags: ["products"],
  request: { params: z.object({ id: z.coerce.number().int() }) },
  responses: {
    200: {
      description: "Variant snapshot history",
      content: { "application/json": { schema: z.array(HistoryRowSchema) } },
    },
  },
});

snapshots.openapi(historyRoute, async (c) => {
  const { id } = c.req.valid("param");
  const rs = await getDb().execute({
    sql: `
      SELECT vs.variant_id, v.variant_key, vs.scraped_at, vs.price, vs.lowest_price, vs.regular_price, vs.stock,
             vs.stock - LAG(vs.stock) OVER (PARTITION BY vs.variant_id ORDER BY vs.scraped_at) AS delta_stock
      FROM variant_snapshots vs
      JOIN variants v ON v.id = vs.variant_id
      WHERE v.product_id = ?
      ORDER BY vs.variant_id, vs.scraped_at DESC`,
    args: [id],
  });
  const rows = rs.rows.map((r) => ({
    variant_id: Number(r.variant_id),
    variant_key: String(r.variant_key),
    scraped_at: String(r.scraped_at),
    price: r.price == null ? null : Number(r.price),
    lowest_price: r.lowest_price == null ? null : Number(r.lowest_price),
    regular_price: r.regular_price == null ? null : Number(r.regular_price),
    stock: Number(r.stock),
    delta_stock: r.delta_stock == null ? null : Number(r.delta_stock),
  }));
  return c.json(rows, 200);
});
