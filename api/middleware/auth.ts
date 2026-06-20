import type { MiddlewareHandler } from "hono";
import { getDb } from "../../db/client.js";
import { findApiKey } from "../../db/repo.js";

const TTL_MS = 60_000;
const cache = new Map<string, { id: number; revoked: boolean; ts: number }>();

export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "missing api key" }, 401);
  }
  const key = header.slice("Bearer ".length).trim();
  const now = Date.now();

  let entry = cache.get(key);
  if (!entry || now - entry.ts > TTL_MS) {
    const row = await findApiKey(key);
    if (!row) return c.json({ error: "invalid api key" }, 401);
    entry = { id: row.id, revoked: row.revoked, ts: now };
    cache.set(key, entry);
  }
  if (entry.revoked) return c.json({ error: "invalid api key" }, 401);

  const id = entry.id;
  void getDb()
    .execute({
      sql: `UPDATE api_keys SET last_used_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), id],
    })
    .catch(() => {});

  await next();
};
