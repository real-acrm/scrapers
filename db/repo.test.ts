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

  it("writeProductBatch persists a product graph in one batch", async () => {
    await repo.writeProductBatch(
      {
        wholesalerId: "naleo",
        symbol: "BP1",
        name: "Batch product",
        brand: "BatchBrand",
        image: "https://img/bp1.jpg",
        href: "https://x/bp1",
        labels: ["NEW"],
        categoryPath: ["Kobieta", "Sukienki", "Maxi"],
        variants: [
          {
            optionValues: [
              { optionName: "Kolor", value: "Czarny" },
              { optionName: "Rozmiar", value: "M" },
            ],
            price: 199.99,
            currency: "PLN",
            stock: 4,
          },
        ],
      },
      "2026-06-21T10:00:00Z",
    );

    const prod = await getDb().execute(
      "SELECT id, name, brand_id, labels_json FROM products WHERE wholesaler_id='naleo' AND symbol='BP1'",
    );
    expect(prod.rows[0].name).toBe("Batch product");
    expect(prod.rows[0].brand_id).not.toBeNull();
    expect(prod.rows[0].labels_json).toBe('["NEW"]');

    const cats = await getDb().execute(
      "SELECT COUNT(*) AS n FROM categories WHERE wholesaler_id='naleo'",
    );
    expect(Number(cats.rows[0].n)).toBe(3);

    const link = await getDb().execute(
      "SELECT COUNT(*) AS n FROM product_categories WHERE product_id = " +
        prod.rows[0].id,
    );
    expect(Number(link.rows[0].n)).toBe(1);

    const snap = await getDb().execute(
      "SELECT price, stock FROM variant_snapshots WHERE wholesaler_id='naleo'",
    );
    expect(snap.rows).toHaveLength(1);
    expect(Number(snap.rows[0].price)).toBe(199.99);
    expect(Number(snap.rows[0].stock)).toBe(4);
  });

  it("writeProductBatch is idempotent and refreshes mutable fields", async () => {
    const p = {
      wholesalerId: "naleo",
      symbol: "BP2",
      name: "v1",
      brand: null,
      image: null,
      href: null,
      labels: [],
      categoryPath: ["A", "B"],
      variants: [
        {
          optionValues: [{ optionName: "Size", value: "L" }],
          price: 10,
          currency: "PLN",
          stock: 1,
        },
      ],
    };
    await repo.writeProductBatch(p, "2026-06-21T10:00:00Z");
    await repo.writeProductBatch(
      { ...p, name: "v2", variants: [{ ...p.variants[0], sku: "SKU-X" }] },
      "2026-06-21T11:00:00Z",
    );

    const prod = await getDb().execute(
      "SELECT id, name FROM products WHERE wholesaler_id='naleo' AND symbol='BP2'",
    );
    expect(prod.rows[0].name).toBe("v2");

    const cats = await getDb().execute(
      "SELECT COUNT(*) AS n FROM categories WHERE wholesaler_id='naleo'",
    );
    expect(Number(cats.rows[0].n)).toBe(2);

    const vars = await getDb().execute(
      "SELECT sku FROM variants WHERE product_id = " + prod.rows[0].id,
    );
    expect(vars.rows).toHaveLength(1);
    expect(vars.rows[0].sku).toBe("SKU-X");

    const snaps = await getDb().execute(
      "SELECT COUNT(*) AS n FROM variant_snapshots",
    );
    expect(Number(snaps.rows[0].n)).toBe(2);
  });

  it("writeProductBatch skips snapshot when variant stock is null", async () => {
    await repo.writeProductBatch(
      {
        wholesalerId: "naleo",
        symbol: "BP3",
        name: "no-stock",
        brand: null,
        image: null,
        href: null,
        labels: [],
        categoryPath: [],
        variants: [
          {
            optionValues: [{ optionName: "Size", value: "S" }],
            price: 50,
            currency: "PLN",
            stock: null,
          },
        ],
      },
      "2026-06-21T10:00:00Z",
    );

    const vars = await getDb().execute(
      `SELECT v.id FROM variants v
         JOIN products p ON p.id = v.product_id
        WHERE p.wholesaler_id='naleo' AND p.symbol='BP3'`,
    );
    expect(vars.rows).toHaveLength(1);

    const links = await getDb().execute(
      `SELECT COUNT(*) AS n FROM variant_option_values vov
         WHERE vov.variant_id = ` + vars.rows[0].id,
    );
    expect(Number(links.rows[0].n)).toBe(1);

    const snaps = await getDb().execute(
      "SELECT COUNT(*) AS n FROM variant_snapshots",
    );
    expect(Number(snaps.rows[0].n)).toBe(0);
  });

  it("writeProductBatch shares category ancestors across products", async () => {
    await repo.writeProductBatch(
      {
        wholesalerId: "naleo",
        symbol: "BP4a",
        name: "a",
        brand: null,
        image: null,
        href: null,
        labels: [],
        categoryPath: ["Top", "Mid", "LeafA"],
        variants: [],
      },
      "2026-06-21T10:00:00Z",
    );
    await repo.writeProductBatch(
      {
        wholesalerId: "naleo",
        symbol: "BP4b",
        name: "b",
        brand: null,
        image: null,
        href: null,
        labels: [],
        categoryPath: ["Top", "Mid", "LeafB"],
        variants: [],
      },
      "2026-06-21T10:00:00Z",
    );
    const cats = await getDb().execute(
      "SELECT COUNT(*) AS n FROM categories WHERE wholesaler_id='naleo'",
    );
    expect(Number(cats.rows[0].n)).toBe(4);
  });

  it("updateWholesalerLastScraped persists the timestamp", async () => {
    await repo.updateWholesalerLastScraped("naleo", "2026-06-20T08:00:00Z");
    const rs = await getDb().execute(
      "SELECT last_scraped_at FROM wholesalers WHERE id = 'naleo'",
    );
    expect(rs.rows[0].last_scraped_at).toBe("2026-06-20T08:00:00Z");
  });
});
