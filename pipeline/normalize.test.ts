import { describe, it, expect, beforeEach } from "vitest";
import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { __setDbForTesting, getDb } from "../db/client.js";
import * as repo from "../db/repo.js";
import { writeScrapedProduct } from "./normalize.js";
import type { ScrapedProduct } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function freshDb() {
  const c = createClient({ url: ":memory:" });
  const sql = readFileSync(join(__dirname, "../db/schema.sql"), "utf8");
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

async function countRows(table: string): Promise<number> {
  const rs = await getDb().execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rs.rows[0].n);
}

const multiVariantProduct: ScrapedProduct = {
  wholesalerId: "naleo",
  symbol: "SYM123",
  name: "Test Dress",
  brand: "TestBrand",
  image: "https://img",
  href: "https://href",
  labels: ["SALE"],
  categoryPath: ["Kobieta", "Sukienki", "Maxi"],
  variants: [
    {
      optionValues: [
        { optionName: "Kolor", value: "Czarny" },
        { optionName: "Rozmiar", value: "S" },
      ],
      price: 99.99,
      stock: 3,
    },
    {
      optionValues: [
        { optionName: "Kolor", value: "Czarny" },
        { optionName: "Rozmiar", value: "M" },
      ],
      price: 99.99,
      stock: 0,
    },
  ],
};

describe("normalize", () => {
  beforeEach(freshDb);

  it("writes brand, category chain, product, options, variants, snapshots for a multi-variant product", async () => {
    await writeScrapedProduct(multiVariantProduct, "2026-06-20T08:00:00Z");
    expect(await countRows("brands")).toBe(1);
    expect(await countRows("categories")).toBe(3);
    expect(await countRows("products")).toBe(1);
    expect(await countRows("product_options")).toBe(2);
    expect(await countRows("product_option_values")).toBe(3);
    expect(await countRows("variants")).toBe(2);
    expect(await countRows("variant_snapshots")).toBe(2);
  });

  it("appends new snapshots on second run without duplicating metadata", async () => {
    await writeScrapedProduct(multiVariantProduct, "2026-06-20T08:00:00Z");
    await writeScrapedProduct(multiVariantProduct, "2026-06-20T20:00:00Z");
    expect(await countRows("products")).toBe(1);
    expect(await countRows("variants")).toBe(2);
    expect(await countRows("variant_snapshots")).toBe(4);
  });

  it("handles flat product (single option)", async () => {
    const flat: ScrapedProduct = {
      wholesalerId: "naleo",
      symbol: "FLAT1",
      name: "Tank",
      brand: null,
      image: null,
      href: null,
      labels: [],
      categoryPath: ["Mężczyzna", "Koszulki"],
      variants: [
        {
          optionValues: [{ optionName: "Wariant", value: "Czarny S" }],
          price: 49.99,
          stock: 5,
        },
        {
          optionValues: [{ optionName: "Wariant", value: "Czarny M" }],
          price: 49.99,
          stock: 2,
        },
      ],
    };
    await writeScrapedProduct(flat, "2026-06-20T08:00:00Z");
    expect(await countRows("product_options")).toBe(1);
    expect(await countRows("product_option_values")).toBe(2);
    expect(await countRows("variants")).toBe(2);
    expect(await countRows("variant_snapshots")).toBe(2);
  });
});
