import { relations, sql, type InferSelectModel } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const wholesalers = pgTable("wholesalers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  lastScrapedAt: text("last_scraped_at"),
});

export const brands = pgTable(
  "brands",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    wholesalerId: text("wholesaler_id")
      .notNull()
      .references(() => wholesalers.id),
    name: text("name").notNull(),
  },
  (t) => [unique("brands_wholesaler_name_unique").on(t.wholesalerId, t.name)],
);

export const categories = pgTable(
  "categories",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    wholesalerId: text("wholesaler_id")
      .notNull()
      .references(() => wholesalers.id),
    parentId: bigint("parent_id", { mode: "number" }),
    name: text("name").notNull(),
  },
  (t) => [
    uniqueIndex("uq_categories_path").on(
      t.wholesalerId,
      sql`COALESCE(${t.parentId}, 0)`,
      t.name,
    ),
  ],
);

export const products = pgTable(
  "products",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    wholesalerId: text("wholesaler_id")
      .notNull()
      .references(() => wholesalers.id),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    brandId: bigint("brand_id", { mode: "number" }).references(() => brands.id),
    categoryId: bigint("category_id", { mode: "number" }).references(
      () => categories.id,
    ),
    image: text("image"),
    href: text("href"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("products_wholesaler_symbol_unique").on(t.wholesalerId, t.symbol),
    index("idx_products_wholesaler").on(t.wholesalerId),
  ],
);

export const productCategories = pgTable(
  "product_categories",
  {
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    categoryId: bigint("category_id", { mode: "number" })
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.categoryId] }),
    index("idx_product_categories_category").on(t.categoryId),
  ],
);

export const productOptions = pgTable(
  "product_options",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => [unique("product_options_product_name_unique").on(t.productId, t.name)],
);

export const productOptionValues = pgTable(
  "product_option_values",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    optionId: bigint("option_id", { mode: "number" })
      .notNull()
      .references(() => productOptions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => [unique("product_option_values_option_name_unique").on(t.optionId, t.name)],
);

export const variants = pgTable(
  "variants",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantKey: text("variant_key").notNull(),
    sku: text("sku"),
  },
  (t) => [
    unique("variants_product_key_unique").on(t.productId, t.variantKey),
    index("idx_variants_sku").on(t.sku),
  ],
);

export const variantOptionValues = pgTable(
  "variant_option_values",
  {
    variantId: bigint("variant_id", { mode: "number" })
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
    optionValueId: bigint("option_value_id", { mode: "number" })
      .notNull()
      .references(() => productOptionValues.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.variantId, t.optionValueId] })],
);

export const variantSnapshots = pgTable(
  "variant_snapshots",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    variantId: bigint("variant_id", { mode: "number" })
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
    wholesalerId: text("wholesaler_id")
      .notNull()
      .references(() => wholesalers.id),
    scrapedAt: text("scraped_at").notNull(),
    price: doublePrecision("price"),
    regularPrice: doublePrecision("regular_price"),
    srp: doublePrecision("srp"),
    currency: text("currency", { enum: ["EUR", "PLN"] }).notNull(),
    stock: integer("stock").notNull(),
  },
  (t) => [
    index("idx_variant_snapshots_variant_time").on(t.variantId, t.scrapedAt),
    index("idx_variant_snapshots_wholesaler_time").on(
      t.wholesalerId,
      t.scrapedAt,
    ),
  ],
);

// Relations for the relational query API (db.query.products.findFirst({with: ...})).
export const productsRelations = relations(products, ({ one, many }) => ({
  wholesaler: one(wholesalers, {
    fields: [products.wholesalerId],
    references: [wholesalers.id],
  }),
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
  category: one(categories, {
    fields: [products.categoryId],
    references: [categories.id],
  }),
  productCategories: many(productCategories),
  variants: many(variants),
  options: many(productOptions),
}));

export const variantsRelations = relations(variants, ({ one, many }) => ({
  product: one(products, {
    fields: [variants.productId],
    references: [products.id],
  }),
  snapshots: many(variantSnapshots),
  optionValues: many(variantOptionValues),
}));

export const variantSnapshotsRelations = relations(
  variantSnapshots,
  ({ one }) => ({
    variant: one(variants, {
      fields: [variantSnapshots.variantId],
      references: [variants.id],
    }),
  }),
);

export const variantOptionValuesRelations = relations(
  variantOptionValues,
  ({ one }) => ({
    variant: one(variants, {
      fields: [variantOptionValues.variantId],
      references: [variants.id],
    }),
    optionValue: one(productOptionValues, {
      fields: [variantOptionValues.optionValueId],
      references: [productOptionValues.id],
    }),
  }),
);

export const productOptionsRelations = relations(
  productOptions,
  ({ one, many }) => ({
    product: one(products, {
      fields: [productOptions.productId],
      references: [products.id],
    }),
    values: many(productOptionValues),
  }),
);

export const productOptionValuesRelations = relations(
  productOptionValues,
  ({ one }) => ({
    option: one(productOptions, {
      fields: [productOptionValues.optionId],
      references: [productOptions.id],
    }),
  }),
);

export const productCategoriesRelations = relations(
  productCategories,
  ({ one }) => ({
    product: one(products, {
      fields: [productCategories.productId],
      references: [products.id],
    }),
    category: one(categories, {
      fields: [productCategories.categoryId],
      references: [categories.id],
    }),
  }),
);

export const categoriesRelations = relations(categories, ({ one }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
  }),
}));

export type Wholesaler = InferSelectModel<typeof wholesalers>;
export type Brand = InferSelectModel<typeof brands>;
export type Category = InferSelectModel<typeof categories>;
export type Product = InferSelectModel<typeof products>;
export type Variant = InferSelectModel<typeof variants>;
export type VariantSnapshot = InferSelectModel<typeof variantSnapshots>;
