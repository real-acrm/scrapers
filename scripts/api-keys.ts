import "dotenv/config";
import { randomBytes } from "crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { apiKeys } from "../db/schema.js";

async function main(): Promise<void> {
  const db = getDb();
  const sub = process.argv[2];
  const arg = process.argv[3];

  if (sub === "create") {
    if (!arg) {
      console.error("usage: keys:create -- <label>");
      process.exit(1);
    }
    const key = "pk_" + randomBytes(16).toString("hex");
    const [row] = await db
      .insert(apiKeys)
      .values({ key, label: arg, createdAt: new Date().toISOString() })
      .returning({ id: apiKeys.id });
    console.log(`id=${row.id} key=${key}`);
    return;
  }

  if (sub === "list") {
    const rows = await db.select().from(apiKeys).orderBy(asc(apiKeys.id));
    for (const r of rows) {
      const masked = `${r.key.slice(0, 8)}…${r.key.slice(-4)}`;
      const status = r.revokedAt ? `revoked@${r.revokedAt}` : "active";
      console.log(
        `${r.id}\t${r.label}\t${masked}\tcreated=${r.createdAt}\tlast_used=${r.lastUsedAt ?? "-"}\t${status}`,
      );
    }
    return;
  }

  if (sub === "revoke") {
    const id = Number(arg);
    if (!Number.isFinite(id)) {
      console.error("usage: keys:revoke -- <id>");
      process.exit(1);
    }
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
    console.log(`revoked id=${id}`);
    return;
  }

  console.error("usage: api-keys.ts <create|list|revoke> [arg]");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
