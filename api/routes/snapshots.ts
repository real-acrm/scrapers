import { Hono } from "hono";
import { getDb } from "../../db/client.js";

export const snapshots = new Hono();

snapshots.get("/:id/history", async (c) => {
  const id = Number(c.req.param("id"));
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
  return c.json(rs.rows);
});
