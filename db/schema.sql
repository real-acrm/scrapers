CREATE TABLE IF NOT EXISTS wholesalers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  last_scraped_at TEXT
);

CREATE TABLE IF NOT EXISTS brands (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wholesaler_id   TEXT NOT NULL REFERENCES wholesalers(id),
  name            TEXT NOT NULL,
  UNIQUE (wholesaler_id, name)
);

CREATE TABLE IF NOT EXISTS categories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wholesaler_id   TEXT NOT NULL REFERENCES wholesalers(id),
  parent_id       INTEGER REFERENCES categories(id),
  name            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_path
  ON categories (wholesaler_id, COALESCE(parent_id, 0), name);

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wholesaler_id   TEXT NOT NULL REFERENCES wholesalers(id),
  symbol          TEXT NOT NULL,
  name            TEXT NOT NULL,
  brand_id        INTEGER REFERENCES brands(id),
  category_id     INTEGER REFERENCES categories(id),
  image           TEXT,
  href            TEXT,
  labels_json     TEXT,
  updated_at      TEXT NOT NULL,
  UNIQUE (wholesaler_id, symbol)
);

CREATE TABLE IF NOT EXISTS product_categories (
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_product_categories_category
  ON product_categories (category_id);

CREATE TABLE IF NOT EXISTS product_options (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  UNIQUE (product_id, name)
);

CREATE TABLE IF NOT EXISTS product_option_values (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  option_id       INTEGER NOT NULL REFERENCES product_options(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  UNIQUE (option_id, name)
);

CREATE TABLE IF NOT EXISTS variants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_key     TEXT NOT NULL,
  sku             TEXT,
  UNIQUE (product_id, variant_key)
);
-- idx_variants_sku is created by db/migrate.ts AFTER the ADD COLUMN step so
-- pre-existing DBs (where sku didn't exist yet) don't fail the index create.

CREATE TABLE IF NOT EXISTS variant_option_values (
  variant_id      INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  option_value_id INTEGER NOT NULL REFERENCES product_option_values(id) ON DELETE CASCADE,
  PRIMARY KEY (variant_id, option_value_id)
);

CREATE TABLE IF NOT EXISTS variant_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id      INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  wholesaler_id   TEXT NOT NULL REFERENCES wholesalers(id),
  scraped_at      TEXT NOT NULL,
  price           REAL,
  lowest_price    REAL,
  regular_price   REAL,
  srp             REAL,
  currency        TEXT,
  stock           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_variant_snapshots_variant_time
  ON variant_snapshots (variant_id, scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_variant_snapshots_wholesaler_time
  ON variant_snapshots (wholesaler_id, scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_wholesaler
  ON products (wholesaler_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT UNIQUE NOT NULL,
  label           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT,
  revoked_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys (key);

CREATE VIEW IF NOT EXISTS v_variant_promo AS
SELECT
  vs.*,
  CASE
    WHEN vs.regular_price IS NOT NULL
      AND vs.price IS NOT NULL
      AND vs.regular_price > vs.price
    THEN ROUND((vs.regular_price - vs.price) * 100.0 / vs.regular_price, 1)
    ELSE NULL
  END AS discount_percent,
  CASE
    WHEN vs.regular_price IS NOT NULL
      AND vs.price IS NOT NULL
      AND vs.regular_price > vs.price
    THEN 1
    ELSE 0
  END AS is_promo
FROM variant_snapshots vs;
