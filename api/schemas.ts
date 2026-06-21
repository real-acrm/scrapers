import { z } from "@hono/zod-openapi";

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

const splitCsv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const brandList = z
  .string()
  .transform(splitCsv)
  .pipe(z.array(z.string().min(1)).min(1))
  .openapi({ type: "string", example: "Nike,Adidas" });

const categoryList = z
  .string()
  .transform((s) => splitCsv(s).map(Number))
  .pipe(z.array(z.number().int()).min(1))
  .openapi({ type: "string", example: "12,13" });

export const ProductsQuerySchema = z.object({
  wholesaler: z.string().optional(),
  brand: brandList.optional(),
  category: categoryList.optional(),
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

export const FacetsSchema = z
  .object({
    wholesaler: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        count: z.number().int(),
      }),
    ),
    brand: z.array(
      z.object({
        value: z.string(),
        label: z.string(),
        count: z.number().int(),
      }),
    ),
    category: z.array(
      z.object({
        value: z.string(),
        label: z.string(),
        count: z.number().int(),
      }),
    ),
    in_stock: z.object({ true: z.number().int(), false: z.number().int() }),
    on_promo: z.object({ true: z.number().int(), false: z.number().int() }),
    price: z.object({ min: z.number(), max: z.number() }),
  })
  .openapi("Facets");

export type Facets = z.infer<typeof FacetsSchema>;

export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Variant = z.infer<typeof VariantSchema>;
export type ProductListItem = z.infer<typeof ProductListItemSchema>;
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
export type ProductsQuery = z.infer<typeof ProductsQuerySchema>;
