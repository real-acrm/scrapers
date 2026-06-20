import { describe, it, expect, beforeEach } from "vitest";
import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { __setDbForTesting, getDb } from "./client.js";
import * as repo from "./repo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function freshDb() {
  const c = createClient({ url: ":memory:" });
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  for (const s of sql
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)) {
    await c.execute(s);
  }
  __setDbForTesting(c);
  await repo.upsertWholesaler({
    id: "naleo",
    name: "B2B Naleo",
    url: "https://b2b-naleo.pl",
  });
}

describe("repo", () => {
  beforeEach(freshDb);

  it("upsertBrand returns the same id when called twice", async () => {
    const a = await repo.upsertBrand("naleo", "BrandX");
    const b = await repo.upsertBrand("naleo", "BrandX");
    expect(a).toBe(b);
  });

  it("upsertCategoryPath is idempotent and shares ancestors", async () => {
    const leafA = await repo.upsertCategoryPath("naleo", [
      "Kobieta",
      "Sukienki",
      "Maxi",
    ]);
    const leafB = await repo.upsertCategoryPath("naleo", [
      "Kobieta",
      "Sukienki",
      "Maxi",
    ]);
    expect(leafA).toBe(leafB);

    const sibling = await repo.upsertCategoryPath("naleo", [
      "Kobieta",
      "Sukienki",
      "Midi",
    ]);
    expect(sibling).not.toBe(leafA);

    const all = await getDb().execute(
      "SELECT COUNT(*) AS n FROM categories WHERE wholesaler_id = 'naleo'",
    );
    expect(Number(all.rows[0].n)).toBe(4);
  });

  it("upsertProduct upserts on (wholesalerId, symbol)", async () => {
    const a = await repo.upsertProduct({
      wholesalerId: "naleo",
      symbol: "S1",
      name: "A",
      brandId: null,
      categoryId: null,
      image: null,
      href: null,
      labels: [],
    });
    const b = await repo.upsertProduct({
      wholesalerId: "naleo",
      symbol: "S1",
      name: "A renamed",
      brandId: null,
      categoryId: null,
      image: null,
      href: null,
      labels: ["SALE"],
    });
    expect(a).toBe(b);
    const rs = await getDb().execute(
      "SELECT name, labels_json FROM products WHERE id = " + a,
    );
    expect(rs.rows[0].name).toBe("A renamed");
    expect(rs.rows[0].labels_json).toBe('["SALE"]');
  });

  it("upsertVariant builds canonical key from sorted option names", async () => {
    const pid = await repo.upsertProduct({
      wholesalerId: "naleo",
      symbol: "S2",
      name: "P",
      brandId: null,
      categoryId: null,
      image: null,
      href: null,
      labels: [],
    });
    const kolor = await repo.upsertOptionAndValues(pid, "Kolor", ["Czarny"]);
    const rozm = await repo.upsertOptionAndValues(pid, "Rozmiar", ["M"]);
    const vA = await repo.upsertVariant(pid, [
      kolor.get("Czarny")!,
      rozm.get("M")!,
    ]);
    const vB = await repo.upsertVariant(pid, [
      rozm.get("M")!,
      kolor.get("Czarny")!,
    ]);
    expect(vA).toBe(vB);
  });

  it("insertSnapshot appends without touching prior rows", async () => {
    const pid = await repo.upsertProduct({
      wholesalerId: "naleo",
      symbol: "S3",
      name: "P",
      brandId: null,
      categoryId: null,
      image: null,
      href: null,
      labels: [],
    });
    const opt = await repo.upsertOptionAndValues(pid, "Wariant", ["Default"]);
    const vid = await repo.upsertVariant(pid, [opt.get("Default")!]);
    await repo.insertSnapshot({
      variantId: vid,
      wholesalerId: "naleo",
      scrapedAt: "2026-06-20T08:00:00Z",
      price: 99.99,
      stock: 3,
    });
    await repo.insertSnapshot({
      variantId: vid,
      wholesalerId: "naleo",
      scrapedAt: "2026-06-20T20:00:00Z",
      price: 89.99,
      stock: 2,
    });
    const rs = await getDb().execute(
      "SELECT COUNT(*) AS n FROM variant_snapshots",
    );
    expect(Number(rs.rows[0].n)).toBe(2);
  });

  it("updateWholesalerLastScraped persists the timestamp", async () => {
    await repo.updateWholesalerLastScraped("naleo", "2026-06-20T08:00:00Z");
    const rs = await getDb().execute(
      "SELECT last_scraped_at FROM wholesalers WHERE id = 'naleo'",
    );
    expect(rs.rows[0].last_scraped_at).toBe("2026-06-20T08:00:00Z");
  });
});
