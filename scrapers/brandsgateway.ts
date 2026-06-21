import "dotenv/config";
import { BaseScraper } from "./base.js";
import { paginateIndex } from "./lib/meilisearch.js";
import type { ScrapedProduct, ScrapedVariant } from "../pipeline/types.js";

const MEILI_HOST_DEFAULT =
  "https://ms-d6cb72b42c13-7746.fra.meilisearch.io";
// Public search-only key embedded in their frontend JS; any logged-in user
// gets the same one. Safe to ship as a default; override via env if rotated.
const MEILI_TOKEN_DEFAULT =
  "1cc095dbf2dd18c84a5bc2661cc4450cd114e523e28b42f13559ec20262a06c0";

type MeiliCategoryLevel = string[] | undefined;
type MeiliHit = {
  id?: number;
  sku?: string;
  name?: string;
  brand?: string;
  image?: string;
  permalink?: string;
  price?: number;
  regular_price?: number;
  quantity?: number;
  in_stock_variations?: number;
  size?: string[];
  variation_skus?: string[];
  gender?: string;
  brand_tier?: string;
  category_hierarchical?: {
    lvl0?: MeiliCategoryLevel;
    lvl1?: MeiliCategoryLevel;
    lvl2?: MeiliCategoryLevel;
  };
  category?: { name: string; level: number }[];
};

export class BrandsgatewayScraper extends BaseScraper {
  readonly id = "brandsgateway";
  readonly displayName = "BrandsGateway";
  readonly homeUrl = "https://app.brandsgateway.com";

  async *scrape(): AsyncGenerator<ScrapedProduct> {
    const mode = (process.env.BRANDSGATEWAY_MODE ?? "full").toLowerCase();
    if (mode === "full") {
      yield* this.scrapeFull();
      return;
    }
    if (mode === "detail") {
      // Mode B lives in a separate commit (and is invoked via a dedicated
      // CLI script, not the regular scrape loop). Bail loudly so the cron
      // can't accidentally call it through the wrong entry point.
      throw new Error(
        `[${this.id}] mode=detail must be run via scripts/trickle-brandsgateway-details.ts`,
      );
    }
    throw new Error(`[${this.id}] unknown BRANDSGATEWAY_MODE=${mode}`);
  }

  /**
   * Mode A: pull the full catalog from Meilisearch in ~56 paginated calls.
   * No browser, no WordPress session — the search token is enough.
   *
   * For multi-size products we emit one variant per size with stock=null
   * (Meilisearch only exposes total quantity per product). The trickle then
   * fills in per-variant stock from detail HTML.
   */
  private async *scrapeFull(): AsyncGenerator<ScrapedProduct> {
    const host = process.env.BRANDSGATEWAY_MEILI_HOST ?? MEILI_HOST_DEFAULT;
    const token = process.env.BRANDSGATEWAY_MEILI_TOKEN ?? MEILI_TOKEN_DEFAULT;
    console.log(`[${this.id}] mode=full host=${host}`);
    let n = 0;
    for await (const product of paginateIndex<ScrapedProduct>({
      host,
      token,
      indexUid: "product",
      mapHit: (hit) => mapHit(hit as MeiliHit, this.id),
      onFirstResponse: ({ estimatedTotalHits }) => {
        console.log(
          `[${this.id}] meilisearch reports ${estimatedTotalHits ?? "unknown"} total hits`,
        );
      },
    })) {
      n++;
      if (n % 1000 === 0) console.log(`[${this.id}] ${n} products yielded`);
      yield product;
    }
    console.log(`[${this.id}] mode=full done, ${n} products`);
  }
}

function mapHit(hit: MeiliHit, wholesalerId: string): ScrapedProduct | null {
  const symbol = hit.sku || (hit.id != null ? String(hit.id) : null);
  if (!symbol || !hit.name) return null;

  const variants: ScrapedVariant[] = [];
  const sizes = hit.size ?? [];
  const skus = hit.variation_skus ?? [];
  if (sizes.length === 0) {
    // Single-variant product (e.g. wallet, cardholder). Meilisearch's
    // `quantity` is therefore the per-variant stock — record it as such.
    variants.push({
      optionValues: [{ optionName: "Rozmiar", value: "ONE" }],
      price: hit.price ?? null,
      srp: hit.regular_price,
      currency: "EUR",
      sku: skus[0] || symbol,
      stock: typeof hit.quantity === "number" ? hit.quantity : 0,
    });
  } else {
    for (let i = 0; i < sizes.length; i++) {
      variants.push({
        optionValues: [{ optionName: "Rozmiar", value: sizes[i] }],
        price: hit.price ?? null,
        srp: hit.regular_price,
        currency: "EUR",
        sku: skus[i],
        stock: null, // trickle will fill this in from the detail page
      });
    }
  }

  return {
    wholesalerId,
    symbol,
    name: hit.name,
    brand: hit.brand ?? null,
    image: hit.image ?? null,
    href: hit.permalink ?? null,
    categoryPath: pickCategoryPath(hit),
    variants,
  };
}

function pickCategoryPath(hit: MeiliHit): string[] {
  // Prefer the deepest hierarchical level that's populated. Strings come as
  // "A > B > C" (joined with " > "); split on the same separator.
  const lvls = hit.category_hierarchical;
  const deepest =
    lvls?.lvl2?.[0] ?? lvls?.lvl1?.[0] ?? lvls?.lvl0?.[0];
  if (deepest) return deepest.split(" > ").map((s) => s.trim()).filter(Boolean);
  // Fallback: the flat category[] array ordered by level.
  if (Array.isArray(hit.category)) {
    return [...hit.category]
      .sort((a, b) => a.level - b.level)
      .map((c) => c.name)
      .filter(Boolean);
  }
  return [];
}
