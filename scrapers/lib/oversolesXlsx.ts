import * as XLSX from "xlsx";
import type { ScrapedProduct, ScrapedVariant } from "../../pipeline/types.js";
import { extractOversolesImages } from "./oversolesImages.js";

const SHEET_NAME = "Available";

type CellWithLink = XLSX.CellObject & { l?: { Target?: string } };

// Stock cells: integer, null, or capped string like "50+"/"200+".
function parseCellStock(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.trunc(raw) : 0;
  const m = String(raw).trim().match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function str(v: unknown, fallback = ""): string {
  return v !== null && v !== undefined ? String(v).trim() : fallback;
}

function toPrice(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseOversolesWorkbook(
  buf: ArrayBuffer | Buffer,
): ScrapedProduct[] {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const sheet = wb.Sheets[SHEET_NAME];
  if (!sheet) {
    throw new Error(
      `parseOversolesWorkbook: sheet "${SHEET_NAME}" not found ` +
        `(sheets: ${wb.SheetNames.join(", ") || "(none)"})`,
    );
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  // Header row is at index 1 (row 1 is the "Report generated on …" banner).
  // Size labels live from col 7 onward.
  const header = rows[1] ?? [];
  const sizeLabels: (string | null)[] = header.map((h, i) => {
    if (i < 7) return null;
    const label = str(h);
    return label === "" ? null : label;
  });

  const images = extractOversolesImages(buf);
  const products: ScrapedProduct[] = [];

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const symbol = str(row[2]);
    if (!symbol) continue;

    const name = str(row[3], symbol);
    const price = toPrice(row[4]);
    const brand = str(row[5]) || null;

    const linkCell = sheet[XLSX.utils.encode_cell({ c: 1, r })] as
      | CellWithLink
      | undefined;
    const href = linkCell?.l?.Target ?? null;

    const variants: ScrapedVariant[] = [];
    for (let c = 7; c < row.length; c++) {
      const size = sizeLabels[c];
      if (!size) continue;
      const stock = parseCellStock(row[c]);
      if (stock <= 0) continue;
      variants.push({
        optionValues: [{ optionName: "Size", value: size }],
        price,
        currency: "EUR",
        stock,
      });
    }
    if (variants.length === 0) continue;

    products.push({
      wholesalerId: "oversoles",
      symbol,
      name,
      brand,
      image: images.get(r) ?? null,
      href,
      categoryPath: [],
      variants,
    });
  }

  return products;
}
