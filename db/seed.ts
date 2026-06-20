import "dotenv/config";
import { migrate } from "./migrate.js";
import { upsertWholesaler, updateWholesalerLastScraped } from "./repo.js";
import { writeScrapedProduct } from "../pipeline/normalize.js";
import type { ScrapedProduct } from "../pipeline/types.js";

const product: ScrapedProduct = {
  wholesalerId: "naleo",
  symbol: "DEMO-1",
  name: "Demo Dress",
  brand: "DemoBrand",
  image: "https://example.com/img.jpg",
  href: "https://example.com/p/demo-1",
  labels: ["DEMO"],
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
  await migrate();
  await upsertWholesaler({
    id: "naleo",
    name: "B2B Naleo",
    url: "https://b2b-naleo.pl",
  });

  const t1 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const t2 = new Date().toISOString();
  await writeScrapedProduct(product, t1);
  // second pass with one stock changed, to exercise delta_stock in /history
  await writeScrapedProduct(
    { ...product, variants: [
      { ...product.variants[0], stock: 3 },
      { ...product.variants[1], stock: 4 },
    ] },
    t2,
  );
  await updateWholesalerLastScraped("naleo", t2);
  console.log("seeded");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
