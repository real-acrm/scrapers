import "dotenv/config";
import * as XLSX from "xlsx";
import { BaseScraper } from "../base.js";
import type { ScrapedProduct, ScrapedVariant } from "../../pipeline/types.js";

/**
 * ARCHETYPE B — catalog file scraper.
 *
 * Use when: the wholesaler publishes an XLSX/CSV of their entire catalog.
 * No browser, no login dance — just download + parse rows.
 *
 * Catalog files almost always emit one row per VARIANT. Group rows by product
 * symbol, then emit one ScrapedProduct per group.
 *
 * Steps to adapt for a new wholesaler:
 *   1. Set id / displayName / homeUrl / catalogUrl.
 *   2. Adjust auth headers if needed.
 *   3. Fill in the column names in rowsToProduct().
 */
export class ArchetypeBCatalogFileTemplate extends BaseScraper {
  readonly id = "TODO_wholesaler_id";
  readonly displayName = "TODO Display Name";
  readonly homeUrl = "https://TODO";

  private readonly catalogUrl = "https://TODO/catalog.xlsx";

  async *scrape(): AsyncGenerator<ScrapedProduct> {
    const buf = await this.fetchCatalogFile(this.catalogUrl, {
      // headers: { Authorization: `Bearer ${process.env.TODO_API_KEY}` },
    });
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

    const byProduct = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const symbol = String(row["TODO_SYMBOL_COL"]);
      if (!symbol || symbol === "undefined") continue;
      if (!byProduct.has(symbol)) byProduct.set(symbol, []);
      byProduct.get(symbol)!.push(row);
    }

    for (const [symbol, group] of byProduct) {
      yield this.rowsToProduct(symbol, group);
    }
  }

  private rowsToProduct(
    symbol: string,
    rows: Record<string, unknown>[],
  ): ScrapedProduct {
    const head = rows[0];

    // TODO: map columns to fields. Split category column on '>' or similar.
    const categoryPath: string[] = String(head["TODO_CATEGORY_COL"] ?? "")
      .split(">")
      .map((s) => s.trim())
      .filter(Boolean);

    const variants: ScrapedVariant[] = rows.map((r) => ({
      optionValues: [
        // TODO: one entry per option axis. Add a second push for Rozmiar etc.
        {
          optionName: "TODO_OPTION_NAME",
          value: String(r["TODO_VARIANT_COL"]),
        },
      ],
      price: Number(r["TODO_PRICE_COL"]) || null,
      stock: Number(r["TODO_STOCK_COL"]) || 0,
    }));

    return {
      wholesalerId: this.id,
      symbol,
      name: String(head["TODO_NAME_COL"]),
      brand: String(head["TODO_BRAND_COL"] ?? "") || null,
      image: String(head["TODO_IMAGE_COL"] ?? "") || null,
      href: null,
      labels: [],
      categoryPath,
      variants,
    };
  }
}
