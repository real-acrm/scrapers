import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { apiKeys } from "../../db/schema.js";

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
    const rows = await getDb()
      .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.key, key))
      .limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: "invalid api key" }, 401);
    entry = { id: row.id, revoked: row.revokedAt != null, ts: now };
    cache.set(key, entry);
  }
  if (entry.revoked) return c.json({ error: "invalid api key" }, 401);

  const id = entry.id;
  void getDb()
    .update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, id))
    .catch(() => {});

  await next();
};
