import XLSX from "xlsx";

/**
 * Extract embedded product images from the goldensneakers XLSX export.
 *
 * The export anchors one 100x100 PNG per product in column A. Each product
 * spans 3 rows starting at row 6 (0-indexed row 5), so the anchor's `from.row`
 * matches the top row of its product. SheetJS drops drawing/media payloads
 * during sheet_to_json, so we walk the OOXML zip ourselves via CFB.
 *
 * Returns Map<sheetName, Map<row, "data:image/png;base64,...">>.
 */
export function extractGoldensneakersImages(
  buf: ArrayBuffer | Buffer,
): Map<string, Map<number, string>> {
  const cfb = XLSX.CFB.read(buf as Buffer, { type: "buffer" });
  const get = (path: string): Buffer | null => {
    const idx = cfb.FullPaths.indexOf("Root Entry/" + path);
    if (idx < 0) return null;
    const entry = cfb.FileIndex[idx];
    if (!entry?.content) return null;
    return Buffer.from(entry.content as Uint8Array);
  };

  const wbXmlBuf = get("xl/workbook.xml");
  const wbRelsBuf = get("xl/_rels/workbook.xml.rels");
  if (!wbXmlBuf || !wbRelsBuf) return new Map();

  const wbXml = wbXmlBuf.toString("utf8");
  const wbRels = parseRels(wbRelsBuf.toString("utf8"));
  const sheets = [...wbXml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)].map(
    (m) => ({ name: m[1], rid: m[2] }),
  );

  const out = new Map<string, Map<number, string>>();
  const wbPath = "xl/workbook.xml";

  for (const sheet of sheets) {
    const target = wbRels[sheet.rid];
    if (!target) continue;
    const sheetPath = resolvePath(wbPath, target);
    const sheetXmlBuf = get(sheetPath);
    if (!sheetXmlBuf) continue;
    const drawingRid = sheetXmlBuf
      .toString("utf8")
      .match(/<drawing\b[^>]*r:id="([^"]+)"/)?.[1];
    if (!drawingRid) continue;

    const sheetRelsPath = sheetPath.replace(/([^/]+)$/, "_rels/$1.rels");
    const sheetRelsBuf = get(sheetRelsPath);
    if (!sheetRelsBuf) continue;
    const sheetRels = parseRels(sheetRelsBuf.toString("utf8"));
    const drawingTarget = sheetRels[drawingRid];
    if (!drawingTarget) continue;
    const drawingPath = resolvePath(sheetRelsPath, drawingTarget);
    const drawingXmlBuf = get(drawingPath);
    if (!drawingXmlBuf) continue;
    const drawingRelsPath = drawingPath.replace(/([^/]+)$/, "_rels/$1.rels");
    const drawingRelsBuf = get(drawingRelsPath);
    if (!drawingRelsBuf) continue;
    const drawingRels = parseRels(drawingRelsBuf.toString("utf8"));
    const drawingXml = drawingXmlBuf.toString("utf8");

    const anchorRe =
      /<(?:oneCellAnchor|twoCellAnchor)\b[\s\S]*?<from>[\s\S]*?<col>(\d+)<\/col>[\s\S]*?<row>(\d+)<\/row>[\s\S]*?<\/from>[\s\S]*?r:embed="([^"]+)"[\s\S]*?<\/(?:oneCellAnchor|twoCellAnchor)>/g;

    const perRow = new Map<number, string>();
    for (const m of drawingXml.matchAll(anchorRe)) {
      const col = Number(m[1]);
      const row = Number(m[2]);
      if (col !== 0) continue;
      const target = drawingRels[m[3]];
      if (!target) continue;
      const mediaPath = resolvePath(drawingRelsPath, target);
      const imgBuf = get(mediaPath);
      if (!imgBuf) continue;
      const mime = mediaPath.endsWith(".jpg") || mediaPath.endsWith(".jpeg")
        ? "image/jpeg"
        : mediaPath.endsWith(".gif")
          ? "image/gif"
          : "image/png";
      perRow.set(row, `data:${mime};base64,${imgBuf.toString("base64")}`);
    }
    if (perRow.size > 0) out.set(sheet.name, perRow);
  }

  return out;
}

function parseRels(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const id = attrs.match(/\bId="([^"]+)"/)?.[1];
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) out[id] = target;
  }
  return out;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  const baseDir = base.replace(/[^/]+$/, "");
  const parts = (baseDir + target).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "..") stack.pop();
    else if (p && p !== ".") stack.push(p);
  }
  return stack.join("/");
}
