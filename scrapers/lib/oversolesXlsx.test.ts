import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseOversolesWorkbook } from "./oversolesXlsx.js";

const FIXTURE = resolve(
  __dirname,
  "..",
  "__fixtures__",
  "oversoles-stock.xlsx",
);

describe("parseOversolesWorkbook", () => {
  const buf = readFileSync(FIXTURE);
  const products = parseOversolesWorkbook(buf);

  it("parses ~495 products from the example file", () => {
    expect(products.length).toBeGreaterThan(400);
    expect(products.length).toBeLessThanOrEqual(495);
  });

  it("every product has symbol, name, ≥1 variant, EUR currency, positive stock", () => {
    for (const p of products) {
      expect(p.wholesalerId).toBe("oversoles");
      expect(p.symbol).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.categoryPath).toEqual([]);
      expect(p.variants.length).toBeGreaterThan(0);
      for (const v of p.variants) {
        expect(v.currency).toBe("EUR");
        expect(v.stock).toBeGreaterThan(0);
        expect(v.optionValues[0]?.optionName).toBe("Size");
      }
    }
  });

  it("maps the first product (JQ8898 Adidas A.E. 1) with brand, EUR 60, hyperlink, image", () => {
    const p = products.find((p) => p.symbol === "JQ8898");
    expect(p).toBeDefined();
    expect(p!.brand).toBe("Adidas");
    expect(p!.name).toContain("Adidas A.E. 1 Low");
    expect(p!.variants.every((v) => v.price === 60)).toBe(true);
    expect(p!.href).toMatch(/oversoles.*\/products\/adidas-a-e-1-low/);
    // RichData image extraction succeeded → base64 data URI with PNG magic.
    expect(p!.image).toMatch(/^data:image\/(png|jpeg|gif);base64,/);
    // PNG signature in base64 starts with "iVBORw0KGgo".
    expect(p!.image!.length).toBeGreaterThan(1000);
  });

  it("clamps capped-stock cells (e.g. 50+) at their leading integer", () => {
    // The JQ8898 row uses '50+' multiple times. Verify each variant's stock
    // is a positive integer ≤ 200 (the largest capped indicator seen).
    const p = products.find((p) => p.symbol === "JQ8898")!;
    const stocks = p.variants.map((v) => v.stock ?? 0);
    expect(stocks.every((s) => Number.isInteger(s) && s > 0 && s <= 200)).toBe(true);
    expect(stocks).toContain(50);
  });

  it("extracts at least one image for the majority of products", () => {
    const withImage = products.filter((p) => p.image !== null).length;
    expect(withImage).toBeGreaterThan(products.length * 0.9);
  });
});
