# Multi-Wholesaler Scraper Backend — Architecture Proposal

## Context
Currently the scraper targets one wholesaler (b2b-naleo.pl) and writes output to Google Sheets with a flat tabular format. The goal is to:
- Replace Google Sheets storage with **MongoDB Atlas** (cloud, free 512 MB tier)
- Refactor the scraper into a pluggable architecture that supports 10 wholesalers
- Add a minimal **REST API** for querying the stored data
- Preserve historical stock-delta tracking across scrape runs

---

## Proposed File Structure

```
scrapers/
  base.ts                  # Abstract BaseScraper: browser setup, login, pagination helpers
  naleo/index.ts           # Naleo-specific implementation (migrated from scrape.tsx)
  wholesaler-2/index.ts    # Future scrapers follow same interface

db/
  client.ts                # MongoDB connection singleton
  products.ts              # upsertProduct(), getProducts()
  snapshots.ts             # insertSnapshot(), getSnapshotHistory()

api/
  index.ts                 # Hono REST API entry point
  routes/products.ts       # GET /products, GET /products/:id
  routes/wholesalers.ts    # GET /wholesalers
  routes/snapshots.ts      # GET /products/:id/history

index.ts                   # Orchestrator: run all scrapers → save to DB
types.ts                   # (existing — extend with DB-oriented types)
```

---

## Database: MongoDB Atlas (recommended)

**Why MongoDB over relational DB:**
- Products have nested variants, options, option values — maps naturally to documents
- Each wholesaler may have slightly different fields — flexible schema handles this without migrations
- Free 512 MB tier is sufficient for 10 wholesalers × daily snapshots
- Atlas has a built-in UI for browsing data

**3 Collections:**

### `wholesalers`
```json
{
  "_id": "naleo",
  "name": "B2B Naleo",
  "url": "https://b2b-naleo.pl",
  "lastScrapedAt": "ISODate"
}
```

### `products`
Product metadata — upserted on each scrape (stable fields only, no stock/price here).
```json
{
  "_id": "naleo::SYM123",
  "wholesalerId": "naleo",
  "symbol": "SYM123",
  "name": "Product Name",
  "brand": "BrandName",
  "image": "https://...",
  "href": "https://...",
  "labels": ["SALE"],
  "category": {
    "gender": "Kobieta",
    "category1": "Sukienki",
    "category2": "Maxi"
  },
  "options": [
    { "name": "Kolor", "values": ["Czarny", "Biały"] },
    { "name": "Rozmiar", "values": ["S", "M", "L"] }
  ],
  "updatedAt": "ISODate"
}
```

### `stockSnapshots`
One document per product per scrape run — full history preserved.
```json
{
  "_id": "ObjectId",
  "productId": "naleo::SYM123",
  "wholesalerId": "naleo",
  "scrapedAt": "ISODate",
  "variants": [
    {
      "variant": "Czarny",
      "subvariant": "S",
      "price": 99.99,
      "lowestPrice": 89.99,
      "regularPrice": 119.99,
      "stock": 5
    }
  ]
}
```

---

## Scraper Architecture

### `scrapers/base.ts` — Abstract BaseScraper
Extracted from current `scrape.tsx`:
- `setup()` — Puppeteer Extra + Stealth, viewport, locale
- `login(url, credentials)` — generic login flow (overridable per wholesaler)
- `paginate(page, onFinish)` — pagination helper
- Abstract `scrape(): Promise<ScrapedProduct[]>` — each wholesaler implements this

### `scrapers/naleo/index.ts`
Migrate current `parsePage()`, `parseProduct()`, `paginate()` from `scrape.tsx` into `NaleoScraper extends BaseScraper`.

### `index.ts` — Orchestrator
```ts
const scrapers = [new NaleoScraper()]  // add more scrapers here
for (const scraper of scrapers) {
  const products = await scraper.scrape()
  for (const p of products) {
    await upsertProduct(p)
    await insertSnapshot(p)
  }
  await updateWholesalerLastScraped(scraper.id)
}
```

---

## API: Hono (lightweight, Vercel-deployable)

**Endpoints:**
- `GET /wholesalers` — list all
- `GET /products?wholesaler=naleo&brand=X&page=1` — paginated product list
- `GET /products/:id` — single product with latest stock
- `GET /products/:id/history` — full snapshot history with stock deltas

**Deployment:** Vercel (free tier, zero config for Node.js)

---

## New Dependencies
```
mongodb        — official driver
hono           — lightweight REST framework
@hono/node-server — local dev server adapter
```

---

## New Environment Variables
```
MONGODB_URI=mongodb+srv://...   # add to .env and GitHub Actions secrets
```

---

## Migration Strategy
1. Build new DB layer + API alongside existing Google Sheets output
2. Run both in parallel for a few scrape cycles to verify parity
3. Remove `to-xlsx.ts`, `upload-to-drive.ts`, `master-sheet.ts` once MongoDB confirmed working

---

## Files to Modify
- `index.ts` — swap output target
- `types.ts` — add DB-aligned types
- `package.json` — add mongodb, hono
- `.github/workflows/scrape.yml` — add MONGODB_URI secret

## Files to Create
- `db/client.ts`, `db/products.ts`, `db/snapshots.ts`
- `scrapers/base.ts`, `scrapers/naleo/index.ts`
- `api/index.ts`, `api/routes/products.ts`, `api/routes/wholesalers.ts`, `api/routes/snapshots.ts`

## Files to Keep Until Migration Confirmed
- `to-xlsx.ts`, `upload-to-drive.ts`, `master-sheet.ts`, `scrape.tsx`
