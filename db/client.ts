import "dotenv/config";
import {
  drizzle as neonDrizzle,
  type NeonDatabase,
} from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import * as schema from "./schema.js";

if (typeof WebSocket === "undefined") {
  neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket;
}

export type Schema = typeof schema;
export type Db = NeonDatabase<Schema>;

let _db: Db | null = null;

export function getDb(): Db {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url });
  _db = neonDrizzle(pool, { schema });
  return _db;
}

export function __setDbForTesting(db: Db): void {
  _db = db;
}
