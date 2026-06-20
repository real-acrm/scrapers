import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseGoldensneakersWorkbook } from "./goldensneakersXlsx.js";

const SAMPLE = join(homedir(), "Downloads", "GS_stock_export.xlsx");

describe.skipIf(!existsSync(SAMPLE))("parseGoldensneakersWorkbook", () => {
  const buf = existsSync(SAMPLE) ? readFileSync(SAMPLE) : Buffer.alloc(0);
  const products = parseGoldensneakersWorkbook(buf);

  it("parses ≥400 products", () => {
    expect(products.length).toBeGreaterThanOrEqual(400);
  });

  it("never includes the union sheet as a brand", () => {
    expect(products.every((p) => p.brand !== "All Assortments")).toBe(true);
  });

  it("every product has symbol, name, brand, ≥1 variant, EUR currency", () => {
    for (const p of products) {
      expect(p.symbol).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.brand).toBeTruthy();
      expect(p.variants.length).toBeGreaterThan(0);
      for (const v of p.variants) {
        expect(v.currency).toBe("EUR");
        expect(v.stock).toBeGreaterThan(0);
        expect(v.optionValues[0]?.optionName).toBe("Rozmiar");
      }
    }
  });

  it("emits expected brand sheets", () => {
    const brands = new Set(products.map((p) => p.brand));
    for (const b of [
      "Jordan",
      "Nike",
      "Adidas",
      "Asics",
      "New Balance",
      "Puma",
      "Vans",
    ]) {
      expect(brands.has(b)).toBe(true);
    }
  });

  it("parses SKU SX7669-100 with a non-empty size set", () => {
    const p = products.find((p) => p.symbol === "SX7669-100");
    expect(p).toBeDefined();
    expect(p!.brand).toBe("Nike");
    expect(p!.variants.length).toBeGreaterThan(0);
  });
});
