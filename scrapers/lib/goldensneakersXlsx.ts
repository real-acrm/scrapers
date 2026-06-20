import * as XLSX from "xlsx";
import type { ScrapedProduct, ScrapedVariant } from "../../pipeline/types.js";

const UNION_SHEET_NAME = "All Assortments";
const HOME = "https://goldensneakers.net";

type CellWithLink = XLSX.CellObject & { l?: { Target?: string } };

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function toInt(v: unknown): number {
  const n = toNumber(v);
  return n === null ? 0 : Math.trunc(n);
}

function parseSheet(
  sheet: XLSX.WorkSheet,
  brand: string,
): ScrapedProduct[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: true,
  });

  const products: ScrapedProduct[] = [];
  // Data starts at row 6 (1-indexed) = rows[5] (0-indexed). Each product spans 3 rows.
  for (let i = 5; i + 2 < rows.length; i += 3) {
    const r0 = rows[i] ?? [];
    const r2 = rows[i + 2] ?? [];
    const symbol = String(r0[1] ?? "").trim();
    if (!symbol) continue;
    const name = String(r0[2] ?? "").trim();
    const price = toNumber(r0[4]);

    // SheetJS exposes the hyperlink on the cell as `.l.Target`.
    const linkCellAddr = XLSX.utils.encode_cell({ c: 3, r: i });
    const linkCell = sheet[linkCellAddr] as CellWithLink | undefined;
    const href =
      linkCell?.l?.Target ??
      `${HOME}/warehouse/assortment-details/${symbol}/`;

    const variants: ScrapedVariant[] = [];
    for (let c = 6; c < r0.length; c++) {
      const size = String(r0[c] ?? "").trim();
      if (!size) continue;
      const stock = toInt(r2[c]);
      if (stock <= 0) continue;
      variants.push({
        optionValues: [{ optionName: "Rozmiar", value: size }],
        price,
        currency: "EUR",
        stock,
      });
    }
    if (variants.length === 0) continue;

    products.push({
      wholesalerId: "goldensneakers",
      symbol,
      name: name || symbol,
      brand,
      image: null,
      href,
      labels: [],
      categoryPath: [brand],
      variants,
    });
  }
  return products;
}

export function parseGoldensneakersWorkbook(
  buf: ArrayBuffer | Buffer,
): ScrapedProduct[] {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const out: ScrapedProduct[] = [];
  for (const name of wb.SheetNames) {
    if (name === UNION_SHEET_NAME) continue;
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    out.push(...parseSheet(sheet, name));
  }
  return out;
}
