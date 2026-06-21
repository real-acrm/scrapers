import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { __setDbForTesting, getDb, type Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { writeScrapedProduct } from "./normalize.js";
import type { ScrapedProduct } from "./types.js";

async function freshDb() {
  const client = new PGlite();
  const db = pgliteDrizzle(client, { schema });
  const { apply } = await pushSchema(schema, db as never);
  await apply();
  __setDbForTesting(db as unknown as Db);
  await getDb()
    .insert(schema.wholesalers)
    .values({ id: "naleo", name: "B2B Naleo", url: "https://b2b-naleo.pl" })
    .onConflictDoNothing();
}

async function countRows(table: string): Promise<number> {
  const rs = await getDb().execute<{ n: number }>(
    sql.raw(`SELECT COUNT(*)::int AS n FROM ${table}`),
  );
  return rs.rows[0].n;
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
