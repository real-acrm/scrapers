import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getDb } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function ensureFileDbDir(): void {
  const url = process.env.TURSO_DATABASE_URL ?? "";
  if (!url.startsWith("file:")) return;
  const path = url.slice("file:".length);
  if (path === ":memory:" || !path.includes("/")) return;
  mkdirSync(dirname(path), { recursive: true });
}

export async function migrate(): Promise<void> {
  ensureFileDbDir();
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  const db = getDb();
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await db.execute(stmt);

  // Idempotent column additions for existing DBs that predate the column.
  // sqlite/libsql doesn't support "ADD COLUMN IF NOT EXISTS", so we attempt
  // each and swallow the "duplicate column" error.
  const ensureColumns: { table: string; column: string; def: string }[] = [
    { table: "variant_snapshots", column: "srp", def: "REAL" },
    { table: "variant_snapshots", column: "currency", def: "TEXT" },
    { table: "variants", column: "sku", def: "TEXT" },
  ];
  for (const { table, column, def } of ensureColumns) {
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    } catch (err) {
      if (!/duplicate column/i.test((err as Error).message)) throw err;
    }
  }
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_variants_sku ON variants (sku)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => {
      console.log("migrated");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
