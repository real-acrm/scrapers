import { Hono } from "hono";
import type { InValue } from "@libsql/client";
import { getDb } from "../../db/client.js";

export const products = new Hono();

products.get("/", async (c) => {
  const wholesaler = c.req.query("wholesaler");
  const brand = c.req.query("brand");
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1"));
  const pageSize = Math.min(200, parseInt(c.req.query("pageSize") ?? "50"));
  const where: string[] = [];
  const args: InValue[] = [];
  if (wholesaler) {
    where.push("p.wholesaler_id = ?");
    args.push(wholesaler);
  }
  if (brand) {
    where.push("b.name = ?");
    args.push(brand);
  }
  const sql = `
    SELECT p.id, p.wholesaler_id, p.symbol, p.name, b.name AS brand, p.image, p.href
    FROM products p LEFT JOIN brands b ON b.id = p.brand_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY p.id LIMIT ? OFFSET ?`;
  args.push(pageSize, (page - 1) * pageSize);
  const rs = await getDb().execute({ sql, args });
  return c.json(rs.rows);
});

products.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = getDb();

  const productRs = await db.execute({
    sql: `SELECT p.*, b.name AS brand
          FROM products p LEFT JOIN brands b ON b.id = p.brand_id
          WHERE p.id = ?`,
    args: [id],
  });
  const product = productRs.rows[0];
  if (!product) return c.notFound();

  const variants = (
    await db.execute({
      sql: `
      SELECT v.id AS variant_id, v.variant_key,
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
    })
  ).rows;

  return c.json({ ...product, variants });
});
