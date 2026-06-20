import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { getDb } from "../../db/client.js";
import {
  PaginatedSchema,
  ProductListItemSchema,
  ProductsQuerySchema,
} from "../schemas.js";
import { buildList } from "./products.js";

export const deals = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["deals"],
  request: { query: ProductsQuerySchema },
  responses: {
    200: {
      description: "Discounted products, sorted by discount desc",
      content: {
        "application/json": {
          schema: PaginatedSchema(ProductListItemSchema),
        },
      },
    },
  },
});

deals.openapi(listRoute, async (c) => {
  const q = c.req.valid("query");
  // Default in_stock=true unless explicitly disabled by the caller.
  const effective = { ...q, in_stock: q.in_stock ?? true };
  const { sql, args } = buildList(effective, true);
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
