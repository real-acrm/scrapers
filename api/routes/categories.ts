import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb } from "../../db/client.js";
import { CategorySchema, type CategoryNode } from "../schemas.js";

export const categories = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/{id}/categories",
  tags: ["facets"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Category tree for a wholesaler",
      content: { "application/json": { schema: z.array(CategorySchema) } },
    },
  },
});

categories.openapi(listRoute, async (c) => {
  const { id } = c.req.valid("param");
  const rs = await getDb().execute({
    sql: `SELECT id, name, parent_id FROM categories WHERE wholesaler_id = ?`,
    args: [id],
  });
  const nodes = new Map<number, CategoryNode>();
  for (const r of rs.rows) {
    const nid = Number(r.id);
    nodes.set(nid, {
      id: nid,
      name: String(r.name),
      parent_id: r.parent_id == null ? null : Number(r.parent_id),
      children: [],
    });
  }
  const roots: CategoryNode[] = [];
  for (const n of nodes.values()) {
    if (n.parent_id == null) {
      roots.push(n);
    } else {
      const parent = nodes.get(n.parent_id);
      if (parent) parent.children.push(n);
      else roots.push(n);
    }
  }
  return c.json(roots, 200);
});
