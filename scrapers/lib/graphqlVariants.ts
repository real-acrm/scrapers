import type { Page } from "puppeteer";
import type { ScrapedVariant } from "../../pipeline/types.js";

/**
 * IdoSell/IAI GraphQL variant fetching for the shared Polish B2B engine used by
 * kajasport (sport-hurtowo.pl) and naleo (b2b-naleo.pl).
 *
 * Instead of DOM-parsing the rendered search list (which collapses single-axis
 * products into a generic "Wariant" option), we replay the site's own
 * `POST /graphql/v1/` request — the exact shape its JS fires — from inside the
 * live browser session. Colour (`versionName`) and size (`sizes[]`) come back
 * cleanly separated, so we emit proper `Kolor` / `Rozmiar` options.
 *
 * Detection posture: we NEVER change the query shape. We replay the captured
 * native query byte-for-byte, varying only the injected product ids and the
 * batch size (the page itself batches ~2–7 products per request).
 */

// ---------------------------------------------------------------------------
// Query template
// ---------------------------------------------------------------------------

export type QueryTemplate = {
  /** Everything before the first `id<N>: product(...)` selection. */
  prefix: string;
  /** One product selection with `__ID__` placeholders for the id + alias. */
  itemTemplate: string;
  /** Text between two product selections (native uses a bare comma). */
  separator: string;
  /** Everything after the last product selection (closing brace + fragment). */
  suffix: string;
};

// Verbatim from a captured native request (only the ids differ per call). Used
// as a fallback when we haven't yet observed a live request to clone. Kept
// byte-identical to the browser's shape so a fallback send is indistinguishable.
const FALLBACK_TEMPLATE: QueryTemplate = {
  prefix: "query {\n        ",
  itemTemplate:
    "id__ID__: product(productId: __ID__, displaySizesByConfig: false) {\n          ...productInfo\n        }",
  separator: ",",
  suffix:
    "\n      }\n      fragment productInfo on ProductResponse {\n" +
    "        product {\n          id\n          type\n          versionName\n" +
    "          unit {\n            name\n            singular\n            plural\n            sellBy\n            precision\n          }\n" +
    "          points\n          pointsReceive\n" +
    "          awardedParameters {\n            name\n            values {\n              name\n              link\n              search {\n                icon\n              }\n            }\n          }\n" +
    "          sizes {\n            name\n            id\n            amount\n            amount_mo\n            amount_mw\n            amount_mp\n" +
    "            availability {\n              visible\n              description\n              status\n              icon\n            }\n" +
    "            price {\n              price {\n                net {\n                  value\n                  formatted\n                }\n              }\n" +
    "              omnibusPrice {\n                net {\n                  value\n                  formatted\n                }\n              }\n" +
    "              omnibusPriceDetails {\n                youSavePercent\n                omnibusPriceIsHigherThanSellingPrice\n                newPriceEffectiveUntil {\n                  formatted\n                }\n              }\n" +
    "              max {\n                net {\n                  value\n                  formatted\n                }\n              }\n" +
    "              youSavePercent\n" +
    "              beforeRebate {\n                net {\n                  value\n                  formatted\n                }\n              }\n" +
    "              beforeRebateDetails {\n                youSavePercent\n              }\n" +
    "              suggested {\n                net {\n                  value\n                  formatted\n                }\n              }\n" +
    "              rebateNumber {\n                number\n                net {\n                  value\n                  formatted\n                }\n              }\n" +
    "              depositPrice {\n                net {\n                  value\n                  formatted\n                }\n              }\n" +
    "              totalDepositPrice {\n                net {\n                  value\n                  formatted\n                }\n              }\n" +
    "            }\n          }\n        }\n      }",
};

// Matches one `id<N>: product(productId: <N>, displaySizesByConfig: false) { ...productInfo }`
// selection. No nested braces inside a selection, so a lazy match to the first
// `}` after `...productInfo` is exact.
const ITEM_RE =
  /id\d+: product\(productId: \d+,[^)]*\)\s*\{[\s\S]*?\.\.\.productInfo[\s\S]*?\}/g;

/** Derive a reusable template from a concrete captured query string. */
export function parseTemplate(query: string): QueryTemplate | null {
  const matches = [...query.matchAll(ITEM_RE)];
  if (matches.length === 0) return null;
  const first = matches[0];
  const last = matches[matches.length - 1];
  const firstStart = first.index!;
  const firstEnd = firstStart + first[0].length;
  const lastStart = last.index!;
  const lastEnd = lastStart + last[0].length;
  const separator =
    matches.length > 1
      ? query.slice(firstEnd, matches[1].index!)
      : FALLBACK_TEMPLATE.separator;
  const itemTemplate = first[0]
    .replace(/id\d+:/, "id__ID__:")
    .replace(/productId: \d+/, "productId: __ID__");
  return {
    prefix: query.slice(0, firstStart),
    itemTemplate,
    separator,
    suffix: query.slice(lastEnd),
  };
}

/**
 * Watches the page for the first native `/graphql/v1/` product request and
 * clones its query shape. Call once per session (before the first listing
 * navigation). `get()` returns the captured template, or the byte-identical
 * fallback until one is seen.
 */
export function createTemplateCapturer(page: Page): {
  get: () => QueryTemplate;
  captured: () => boolean;
  dispose: () => void;
} {
  let tpl: QueryTemplate | null = null;
  const onReq = (req: { url(): string; method(): string; postData(): string | undefined }) => {
    if (tpl) return;
    if (!req.url().includes("/graphql/v1/") || req.method() !== "POST") return;
    const post = req.postData();
    if (!post || !post.includes("product(productId:")) return;
    try {
      const parsed = parseTemplate(JSON.parse(post).query as string);
      if (parsed) {
        tpl = parsed;
        console.log("[graphql] captured native query template");
      }
    } catch {
      // Not JSON we understand — ignore and keep waiting.
    }
  };
  page.on("request", onReq as never);
  return {
    get: () => tpl ?? FALLBACK_TEMPLATE,
    captured: () => tpl != null,
    dispose: () => page.off("request", onReq as never),
  };
}

/** Build the exact `{"query":"..."}` POST body for a batch of product ids. */
export function buildBatchQuery(ids: string[], tpl: QueryTemplate): string {
  const items = ids.map((id) => tpl.itemTemplate.replace(/__ID__/g, id));
  const query = tpl.prefix + items.join(tpl.separator) + tpl.suffix;
  return JSON.stringify({ query });
}

// ---------------------------------------------------------------------------
// GraphQL response types (only the fields we read)
// ---------------------------------------------------------------------------

type GqlNet = { value: number | null } | null;
type GqlSize = {
  name: string;
  amount: number | null;
  price: {
    price?: { net?: GqlNet };
    max?: { net?: GqlNet };
    suggested?: { net?: GqlNet };
  } | null;
};
type GqlProduct = {
  id: number;
  versionName: string | null;
  awardedParameters?: { name: string; values?: { name: string }[] }[];
  sizes?: GqlSize[];
};
type GqlResponse = {
  data?: Record<string, { product: GqlProduct | null } | null>;
};

/**
 * Fetch a batch of products by replaying the native GraphQL request from inside
 * the page (inherits cookies/session/origin/referrer). Returns an id -> product
 * node map. Missing/errored ids are simply absent.
 */
export async function fetchBatch(
  page: Page,
  ids: string[],
  tpl: QueryTemplate,
): Promise<Map<string, GqlProduct>> {
  const body = buildBatchQuery(ids, tpl);
  const json = (await page.evaluate(async (b: string) => {
    const r = await fetch("/graphql/v1/", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      credentials: "include",
      body: b,
    });
    if (!r.ok) return { __httpError: r.status };
    return (await r.json()) as unknown;
  }, body)) as GqlResponse & { __httpError?: number };

  const out = new Map<string, GqlProduct>();
  if (json.__httpError) {
    console.warn(`[graphql] batch HTTP ${json.__httpError} for ids ${ids.join(",")}`);
    return out;
  }
  const data = json.data ?? {};
  for (const id of ids) {
    const node = data[`id${id}`]?.product;
    if (node) out.set(id, node);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapping to ScrapedVariant
// ---------------------------------------------------------------------------

function netValue(n: GqlNet | undefined): number | undefined {
  const v = n?.value;
  return typeof v === "number" ? v : undefined;
}

/**
 * One GraphQL product node -> variants. The node is a single colour; each size
 * becomes a `Rozmiar` variant. `Kolor` is added when the product has a colour
 * (`versionName`, or the `Kolor` awarded parameter). Size-only products (no
 * colour) now emit clean `Rozmiar` rows instead of the legacy generic `Wariant`.
 */
export function toScrapedVariants(node: GqlProduct): ScrapedVariant[] {
  const color =
    node.versionName?.trim() ||
    node.awardedParameters?.find((p) => p.name === "Kolor")?.values?.[0]?.name?.trim() ||
    null;

  const sizes = node.sizes ?? [];
  if (sizes.length === 0) return [];

  return sizes.map((s) => {
    const optionValues = [
      ...(color ? [{ optionName: "Kolor", value: color }] : []),
      { optionName: "Rozmiar", value: s.name },
    ];
    const price = netValue(s.price?.price?.net) ?? null;
    const regularPrice = netValue(s.price?.max?.net); // strikethrough "Cena regularna"
    const srp = netValue(s.price?.suggested?.net); // "Cena sugerowana"
    return {
      optionValues,
      price,
      ...(regularPrice !== undefined && { regularPrice }),
      ...(srp !== undefined && { srp }),
      currency: "PLN" as const,
      stock: typeof s.amount === "number" ? s.amount : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Batching + cadence (mimic the native ~2–7 products/request, ~3–4 average)
// ---------------------------------------------------------------------------

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Draw a batch size weighted toward 3–4, spanning 2–7 like the native page. */
export function nextBatchSize(): number {
  const r = Math.random();
  if (r < 0.5) return randInt(3, 4);
  if (r < 0.8) return randInt(2, 5);
  return randInt(2, 7);
}

/** Split ids into native-looking chunks (order preserved). */
export function chunkForBatches(ids: string[]): string[][] {
  const chunks: string[][] = [];
  let i = 0;
  while (i < ids.length) {
    const size = Math.min(nextBatchSize(), ids.length - i);
    chunks.push(ids.slice(i, i + size));
    i += size;
  }
  return chunks;
}

/** Irregular, sensible inter-batch delay (ms) with the occasional longer pause. */
export function jitterMs(): number {
  return Math.random() < 0.15 ? randInt(2500, 6000) : randInt(400, 2500);
}
