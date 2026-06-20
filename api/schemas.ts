import { z } from "@hono/zod-openapi";

export const WholesalerSchema = z
  .object({
    id: z.string().openapi({ example: "naleo" }),
    name: z.string().openapi({ example: "B2B Naleo" }),
    url: z.string().openapi({ example: "https://b2b-naleo.pl" }),
    last_scraped_at: z.string().nullable(),
  })
  .openapi("Wholesaler");

export const BrandSchema = z
  .object({
    name: z.string(),
    product_count: z.number().int(),
  })
  .openapi("Brand");

export type CategoryNode = {
  id: number;
  name: string;
  parent_id: number | null;
  children: CategoryNode[];
};

export const CategorySchema: z.ZodType<CategoryNode> = z
  .object({
    id: z.number().int(),
    name: z.string(),
    parent_id: z.number().int().nullable(),
    children: z.lazy(() => z.array(CategorySchema)),
  })
  .openapi("Category");

export const SnapshotSchema = z
  .object({
    scraped_at: z.string(),
    price: z.number().nullable(),
    lowest_price: z.number().nullable(),
    regular_price: z.number().nullable(),
    stock: z.number().int(),
  })
  .openapi("Snapshot");

export const VariantSchema = z
  .object({
    variant_id: z.number().int(),
    variant_key: z.string(),
    sku: z.string().nullable(),
    option_values: z.array(z.object({ option: z.string(), value: z.string() })),
    latest_snapshot: SnapshotSchema.nullable(),
  })
  .openapi("Variant");

export const ProductListItemSchema = z
  .object({
    id: z.number().int(),
    wholesaler_id: z.string(),
    symbol: z.string(),
    name: z.string(),
    brand: z.string().nullable(),
    image: z.string().nullable(),
    href: z.string().nullable(),
    min_price: z.number().nullable(),
    currency: z.string().nullable(),
    in_stock: z.boolean(),
    discount_percent: z.number().nullable(),
  })
  .openapi("ProductListItem");

export const ProductDetailSchema = ProductListItemSchema.extend({
  category_id: z.number().int().nullable(),
  labels: z.array(z.string()),
  updated_at: z.string(),
  variants: z.array(VariantSchema),
}).openapi("ProductDetail");

export const HistoryRowSchema = z
  .object({
    variant_id: z.number().int(),
    variant_key: z.string(),
    scraped_at: z.string(),
    price: z.number().nullable(),
    lowest_price: z.number().nullable(),
    regular_price: z.number().nullable(),
    stock: z.number().int(),
    delta_stock: z.number().int().nullable(),
  })
  .openapi("HistoryRow");

export function PaginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    hasMore: z.boolean(),
  });
}

const booleanish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

export const ProductsQuerySchema = z.object({
  wholesaler: z.string().optional(),
  brand: z.string().optional(),
  category: z.coerce.number().int().optional(),
  q: z.string().optional(),
  in_stock: booleanish.optional(),
  on_promo: booleanish.optional(),
  min_price: z.coerce.number().optional(),
  max_price: z.coerce.number().optional(),
  sort: z
    .enum(["newest", "price_asc", "price_desc", "discount_desc"])
    .default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type Wholesaler = z.infer<typeof WholesalerSchema>;
export type Brand = z.infer<typeof BrandSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Variant = z.infer<typeof VariantSchema>;
export type ProductListItem = z.infer<typeof ProductListItemSchema>;
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
export type HistoryRow = z.infer<typeof HistoryRowSchema>;
export type ProductsQuery = z.infer<typeof ProductsQuerySchema>;
