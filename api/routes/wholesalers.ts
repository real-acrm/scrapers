import { Hono } from "hono";
import { getDb } from "../../db/client.js";

export const wholesalers = new Hono();

wholesalers.get("/", async (c) => {
  const rs = await getDb().execute(
    "SELECT id, name, url, last_scraped_at FROM wholesalers",
  );
  return c.json(rs.rows);
});
