import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb } from "../../db/client.js";
import { BrandSchema } from "../schemas.js";

export const brands = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/{id}/brands",
  tags: ["facets"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Brands for a wholesaler with product counts",
      content: { "application/json": { schema: z.array(BrandSchema) } },
    },
  },
});

brands.openapi(listRoute, async (c) => {
  const { id } = c.req.valid("param");
  const rs = await getDb().execute({
    sql: `SELECT b.name AS name, COUNT(p.id) AS product_count
          FROM brands b
          LEFT JOIN products p ON p.brand_id = b.id
          WHERE b.wholesaler_id = ?
          GROUP BY b.id, b.name
          ORDER BY product_count DESC, b.name ASC`,
    args: [id],
  });
  const items = rs.rows.map((r) => ({
    name: String(r.name),
    product_count: Number(r.product_count),
  }));
  return c.json(items, 200);
});
