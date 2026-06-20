export type ScrapedVariant = {
  optionValues: { optionName: string; value: string }[];
  price: number | null;
  lowestPrice?: number;
  regularPrice?: number;
  srp?: number;
  currency?: string;
  // Wholesaler-side SKU per variant (e.g. brandsgateway returns these in
  // variation_skus[]). Optional — most scrapers don't surface a per-variant id.
  sku?: string;
  // null = unknown (e.g. brandsgateway Meilisearch gives total stock per product
  // but not per-size; the trickle fills these in). When null we skip the snapshot.
  stock: number | null;
};

export type ScrapedProduct = {
  wholesalerId: string;
  symbol: string;
  name: string;
  brand: string | null;
  image: string | null;
  href: string | null;
  labels: string[];
  categoryPath: string[];
  variants: ScrapedVariant[];
};
