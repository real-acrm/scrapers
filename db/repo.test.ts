import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { __setDbForTesting, getDb, type Db } from "./client.js";
import * as schema from "./schema.js";
import { writeProductBatch } from "./repo.js";
import type { ScrapedProduct } from "../pipeline/types.js";

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

describe("writeProductBatch", () => {
  beforeEach(freshDb);

  it("persists a product graph in one transaction", async () => {
    await writeProductBatch(
      {
        wholesalerId: "naleo",
        symbol: "BP1",
        name: "Batch product",
        brand: "BatchBrand",
        image: "https://img/bp1.jpg",
        href: "https://x/bp1",
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

    const db = getDb();
    const prod = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.symbol, "BP1"));
    expect(prod[0].name).toBe("Batch product");
    expect(prod[0].brandId).not.toBeNull();

    const cats = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.categories);
    expect(cats[0].n).toBe(3);

    const link = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.productCategories)
      .where(eq(schema.productCategories.productId, prod[0].id));
    expect(link[0].n).toBe(1);

    const snap = await db.select().from(schema.variantSnapshots);
    expect(snap).toHaveLength(1);
    expect(snap[0].price).toBe(199.99);
    expect(snap[0].stock).toBe(4);
  });

  it("is idempotent and refreshes mutable fields + appends snapshots", async () => {
    const p: ScrapedProduct = {
      wholesalerId: "naleo",
      symbol: "BP2",
      name: "v1",
      brand: null,
      image: null,
      href: null,
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
    await writeProductBatch(p, "2026-06-21T10:00:00Z");
    await writeProductBatch(
      { ...p, name: "v2", variants: [{ ...p.variants[0], sku: "SKU-X" }] },
      "2026-06-21T11:00:00Z",
    );

    const db = getDb();
    const prod = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.symbol, "BP2"));
    expect(prod[0].name).toBe("v2");

    const cats = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.categories);
    expect(cats[0].n).toBe(2);

    const vars = await db
      .select()
      .from(schema.variants)
      .where(eq(schema.variants.productId, prod[0].id));
    expect(vars).toHaveLength(1);
    expect(vars[0].sku).toBe("SKU-X");

    const snaps = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.variantSnapshots);
    expect(snaps[0].n).toBe(2);
  });

  it("skips snapshot when variant stock is null", async () => {
    await writeProductBatch(
      {
        wholesalerId: "naleo",
        symbol: "BP3",
        name: "no-stock",
        brand: null,
        image: null,
        href: null,
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

    const db = getDb();
    const vars = await db.select().from(schema.variants);
    expect(vars).toHaveLength(1);

    const links = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.variantOptionValues);
    expect(links[0].n).toBe(1);

    const snaps = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.variantSnapshots);
    expect(snaps[0].n).toBe(0);
  });

  it("shares category ancestors across products", async () => {
    await writeProductBatch(
      {
        wholesalerId: "naleo",
        symbol: "BP4a",
        name: "a",
        brand: null,
        image: null,
        href: null,
        categoryPath: ["Top", "Mid", "LeafA"],
        variants: [],
      },
      "2026-06-21T10:00:00Z",
    );
    await writeProductBatch(
      {
        wholesalerId: "naleo",
        symbol: "BP4b",
        name: "b",
        brand: null,
        image: null,
        href: null,
        categoryPath: ["Top", "Mid", "LeafB"],
        variants: [],
      },
      "2026-06-21T10:00:00Z",
    );

    const cats = await getDb()
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.categories);
    expect(cats[0].n).toBe(4);
  });
});
