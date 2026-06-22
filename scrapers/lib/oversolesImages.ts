import XLSX from "xlsx";

/**
 * Extract embedded product images from the oversoles XLSX export.
 *
 * Unlike the goldensneakers export (legacy DrawingML one/twoCellAnchor under
 * `xl/drawings/`), oversoles uses Excel's newer "Insert Image in Cell" /
 * RichData feature. The column-A cells carry `t="e" vm="N"` (`#VALUE!` text +
 * a value-metadata index). The chain to resolve a vm to image bytes:
 *
 *   sheet cell           — `vm="N"` (1-indexed)
 *   xl/metadata.xml      — `<futureMetadata>` block N contains `<xlrd:rvb i="K"/>`
 *   xl/richData/rdrichvalue.xml — `<rv>` entry K, first `<v>R</v>` (0-indexed)
 *   xl/richData/richValueRel.xml — `<rel>` at index R → r:id="rIdM"
 *   xl/richData/_rels/richValueRel.xml.rels — rIdM → ../media/imageX.ext
 *
 * Returns Map<0-indexed sheet row, "data:image/png;base64,…">.
 */
export function extractOversolesImages(
  buf: ArrayBuffer | Buffer,
): Map<number, string> {
  const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const cfb = XLSX.CFB.read(nodeBuf, { type: "buffer" });
  const get = (path: string): Buffer | null => {
    const idx = cfb.FullPaths.indexOf("Root Entry/" + path);
    if (idx < 0) return null;
    const entry = cfb.FileIndex[idx];
    if (!entry?.content) return null;
    return Buffer.from(entry.content as Uint8Array);
  };

  const out = new Map<number, string>();

  const sheetBuf = get("xl/worksheets/sheet1.xml");
  const metaBuf = get("xl/metadata.xml");
  const rvBuf = get("xl/richData/rdrichvalue.xml");
  const relBuf = get("xl/richData/richValueRel.xml");
  const relRelsBuf = get("xl/richData/_rels/richValueRel.xml.rels");
  if (!sheetBuf || !metaBuf || !rvBuf || !relBuf || !relRelsBuf) return out;

  // 1. row → vm. Worksheet rows are 1-indexed; convert to 0-indexed.
  const rowToVm = new Map<number, number>();
  for (const m of sheetBuf
    .toString("utf8")
    .matchAll(/<c r="A(\d+)"[^>]*\bvm="(\d+)"/g)) {
    rowToVm.set(Number(m[1]) - 1, Number(m[2]));
  }

  // 2. vm → rvb_i. <futureMetadata> blocks are in document order; vm is
  //    1-indexed into them.
  const vmToRvbI: number[] = [];
  for (const m of metaBuf
    .toString("utf8")
    .matchAll(/<xlrd:rvb\s+i="(\d+)"\s*\/>/g)) {
    vmToRvbI.push(Number(m[1]));
  }

  // 3. rvb_i → first <v> per <rv> entry (the relationship index).
  const rvbIToRelIdx: number[] = [];
  for (const m of rvBuf.toString("utf8").matchAll(/<rv\b[^>]*>([\s\S]*?)<\/rv>/g)) {
    const firstV = m[1].match(/<v>(\d+)<\/v>/);
    rvbIToRelIdx.push(firstV ? Number(firstV[1]) : -1);
  }

  // 4. richValueRel index → rId.
  const relIdxToRid: string[] = [];
  for (const m of relBuf
    .toString("utf8")
    .matchAll(/<rel\s+r:id="([^"]+)"\s*\/>/g)) {
    relIdxToRid.push(m[1]);
  }

  // 5. rId → media path.
  const ridToTarget: Record<string, string> = {};
  for (const m of relRelsBuf
    .toString("utf8")
    .matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = m[1].match(/\bId="([^"]+)"/)?.[1];
    const target = m[1].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) ridToTarget[id] = target;
  }

  for (const [row, vm] of rowToVm) {
    const rvbI = vmToRvbI[vm - 1];
    if (rvbI === undefined) continue;
    const relIdx = rvbIToRelIdx[rvbI];
    if (relIdx === undefined || relIdx < 0) continue;
    const rid = relIdxToRid[relIdx];
    if (!rid) continue;
    const target = ridToTarget[rid];
    if (!target) continue;
    // `Target` is like "../media/image2.png" relative to xl/richData/. Resolve.
    const mediaPath = resolvePath("xl/richData/", target);
    const imgBuf = get(mediaPath);
    if (!imgBuf) continue;
    const mime = mediaPath.endsWith(".jpg") || mediaPath.endsWith(".jpeg")
      ? "image/jpeg"
      : mediaPath.endsWith(".gif")
        ? "image/gif"
        : "image/png";
    out.set(row, `data:${mime};base64,${imgBuf.toString("base64")}`);
  }

  return out;
}

function resolvePath(baseDir: string, target: string): string {
  const parts = (baseDir + target).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "..") stack.pop();
    else if (p && p !== ".") stack.push(p);
  }
  return stack.join("/");
}
