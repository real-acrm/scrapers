import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb } from "../../db/client.js";
import { WholesalerSchema } from "../schemas.js";

export const wholesalers = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["wholesalers"],
  responses: {
    200: {
      description: "List of wholesalers",
      content: { "application/json": { schema: z.array(WholesalerSchema) } },
    },
  },
});

wholesalers.openapi(listRoute, async (c) => {
  const rs = await getDb().execute(
    "SELECT id, name, url, last_scraped_at FROM wholesalers",
  );
  const items = rs.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    url: String(r.url),
    last_scraped_at: r.last_scraped_at == null ? null : String(r.last_scraped_at),
  }));
  return c.json(items, 200);
});
