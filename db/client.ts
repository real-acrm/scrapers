import "dotenv/config";
import { createClient, type Client } from "@libsql/client";

let _db: Client | null = null;

export function getDb(): Client {
  if (_db) return _db;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  _db = createClient({ url, authToken });
  // Local file mode only: enable WAL so readers and writers don't block each
  // other, and add a busy_timeout to soak up brief lock contention. Remote
  // Turso ignores these pragmas — safe to call unconditionally on file:/:memory: URLs.
  if (url.startsWith("file:") || url === ":memory:") {
    _db.execute("PRAGMA journal_mode=WAL").catch(() => {});
    _db.execute("PRAGMA busy_timeout=5000").catch(() => {});
  }
  return _db;
}

export function __setDbForTesting(c: Client): void {
  _db = c;
}
