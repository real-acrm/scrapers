import "dotenv/config";
import { GriffatiScraper } from "../scrapers/griffati.js";

// Smoke runner — exercises login, nav extraction, list-view toggle,
// pagination start, and card parsing without touching the database.
// Stops after MAX_PRODUCTS yields so we don't hammer griffati.com.
const MAX_PRODUCTS = Number(process.env.SMOKE_MAX ?? 5);

async function main(): Promise<void> {
  const s = new GriffatiScraper();
  let i = 0;
  for await (const p of s.scrape()) {
    i++;
    console.log(
      `\n[smoke] product ${i}/${MAX_PRODUCTS}:\n` +
        `  symbol  = ${p.symbol}\n` +
        `  brand   = ${p.brand ?? "<null>"}\n` +
        `  name    = ${p.name}\n` +
        `  path    = ${p.categoryPath.join(" / ")}\n` +
        `  image   = ${p.image ? p.image.slice(0, 90) : "<null>"}\n` +
        `  href    = ${p.href ? p.href.slice(0, 90) : "<null>"}\n` +
        `  variants(${p.variants.length}): ${p.variants
          .map(
            (v) =>
              `${v.optionValues.map((o) => o.value).join("/")}@` +
              `${v.price ?? "?"} ${v.currency}`,
          )
          .join(", ")}`,
    );
    if (i >= MAX_PRODUCTS) break;
  }
  console.log(`\n[smoke] consumed ${i} product(s); exiting cleanly.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[smoke] failed:", err);
    process.exit(1);
  });
