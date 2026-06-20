import "dotenv/config";
import { randomBytes } from "crypto";
import { createApiKey, listApiKeys, revokeApiKey } from "../db/repo.js";

async function main(): Promise<void> {
  const sub = process.argv[2];
  const arg = process.argv[3];

  if (sub === "create") {
    if (!arg) {
      console.error("usage: keys:create -- <label>");
      process.exit(1);
    }
    const key = "pk_" + randomBytes(16).toString("hex");
    const id = await createApiKey({ key, label: arg });
    console.log(`id=${id} key=${key}`);
    return;
  }

  if (sub === "list") {
    const rows = await listApiKeys();
    for (const r of rows) {
      const masked = `${r.key.slice(0, 8)}…${r.key.slice(-4)}`;
      const status = r.revoked_at ? `revoked@${r.revoked_at}` : "active";
      console.log(
        `${r.id}\t${r.label}\t${masked}\tcreated=${r.created_at}\tlast_used=${r.last_used_at ?? "-"}\t${status}`,
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
    await revokeApiKey(id);
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
