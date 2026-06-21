import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "./client.js";
import { wholesalers } from "./schema.js";
import { writeScrapedProduct } from "../pipeline/normalize.js";
import type { ScrapedProduct } from "../pipeline/types.js";

const product: ScrapedProduct = {
  wholesalerId: "naleo",
  symbol: "DEMO-1",
  name: "Demo Dress",
  brand: "DemoBrand",
  image: "https://example.com/img.jpg",
  href: "https://example.com/p/demo-1",
  categoryPath: ["Kobieta", "Sukienki", "Maxi"],
  variants: [
    {
      optionValues: [
        { optionName: "Kolor", value: "Czarny" },
        { optionName: "Rozmiar", value: "S" },
      ],
      price: 99.99,
      stock: 5,
    },
    {
      optionValues: [
        { optionName: "Kolor", value: "Czarny" },
        { optionName: "Rozmiar", value: "M" },
      ],
      price: 99.99,
      stock: 2,
    },
  ],
};

async function main() {
  const db = getDb();
  await db
    .insert(wholesalers)
    .values({ id: "naleo", name: "B2B Naleo", url: "https://b2b-naleo.pl" })
    .onConflictDoUpdate({
      target: wholesalers.id,
      set: { name: "B2B Naleo", url: "https://b2b-naleo.pl" },
    });

  const t1 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const t2 = new Date().toISOString();
  await writeScrapedProduct(product, t1);
  await writeScrapedProduct(
    {
      ...product,
      variants: [
        { ...product.variants[0], stock: 3 },
        { ...product.variants[1], stock: 4 },
      ],
    },
    t2,
  );
  await db
    .update(wholesalers)
    .set({ lastScrapedAt: t2 })
    .where(eq(wholesalers.id, "naleo"));
  console.log("seeded");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
