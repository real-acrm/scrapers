# Backend Requirements

Hand-off from frontend to backend agent. The frontend is wiring URL-driven filters (Wholesaler / Brand / Category / In stock / Deal / Price), a faceted filter bar with live counts, and a paginated table backed by `GET /products` and `GET /deals`. This document lists the gaps between the current API and what the frontend needs to ship that UI.

Source of truth for current behavior: `api/schemas.ts`, `api/routes/products.ts`, `api/routes/deals.ts`.

---

## 1. Multi-value `brand` and `category` on `GET /products` and `GET /deals`

Accept comma-joined values for `brand` and `category`:

```
?brand=Nike,Adidas&category=12,13
```

**Semantics:** OR within a field, AND across fields.

**Example:**

```
?wholesaler=naleo&brand=Nike,Adidas&in_stock=true
```

→ products from `naleo` whose brand ∈ {Nike, Adidas} AND that are in stock.

All other existing `ProductsQuery` params (`q`, `in_stock`, `on_promo`, `min_price`, `max_price`, `sort`, `page`, `pageSize`) are unchanged.

**Backend implementation note.** Today `buildList` in `api/routes/products.ts` uses single-value SQL:

```ts
if (q.brand) { where.push("b.name = ?"); args.push(q.brand); }
if (q.category !== undefined) { where.push("p.category_id = ?"); args.push(q.category); }
```

Switch to `b.name IN (?, ?, …)` and `p.category_id IN (?, ?, …)` when more than one value is supplied. Keep the single-value form working — the frontend may send either `?brand=Nike` or `?brand=Nike,Adidas`.

---

## 2. New endpoint: `GET /facets`

Returns chip counts so the filter bar can render e.g. "Nike (42)" under the current filter state.

**Request.** Accepts the **same query params as `/products`** — the currently-applied filter context. `page` and `pageSize` are ignored (or accepted and ignored).

**Response shape:**

```ts
type Facets = {
  wholesaler: Array<{ id: string; name: string; count: number }>;
  brand:      Array<{ value: string; label: string; count: number }>;
  category:   Array<{ value: string; label: string; count: number }>; // value = id stringified
  in_stock:   { true: number; false: number };
  on_promo:   { true: number; false: number };
  price:      { min: number; max: number }; // overall min/max in the filtered set
};
```

**Faceting semantics.**

- **True faceting (preferred):** when computing counts for a given facet, exclude that facet's own filter from the context. So "Nike (42)" means "if I un-select all brands and keep everything else, Nike has 42." This is what users expect from chip counts.
- **Naive faceting (acceptable v1):** counts computed under the full current filter. Ship this first if true faceting is too complex; we can iterate.

`price.min` / `price.max` reflect the min and max `min_price` across the filtered set (after all filters applied), used to bound the price slider.

**Auth.** Same Bearer publishable-key check as `/products`.

---

## 3. `Paginated.total` — confirm real total count

The frontend uses `total` to compute `pageCount = Math.ceil(total / pageSize)`. It must be the **exact total**, not capped, not "N+" style.

Current implementation already satisfies this: `COUNT(*) OVER ()` in `api/routes/products.ts`. Documenting it here so the contract is locked.

---

## 4. Sort enum — unchanged

```
sort: "newest" | "price_asc" | "price_desc" | "discount_desc"
```

Default `newest`. `/deals` may continue to force `discount_desc` server-side.

---

## 5. `pageSize` cap

Frontend default is 50; the maximum value the frontend will send is **100**. Backend currently caps at 200, so this is already supported — please keep the cap at ≥ 100.

---

## 6. CORS

The frontend runs at a different origin than the API (configured via `NEXT_PUBLIC_API_BASE` on the frontend). The backend currently has **no CORS middleware** in `api/server.ts`, so cross-origin requests will be blocked outside of same-origin / localhost dev.

Add `hono/cors` (or equivalent) with:

- Origin: the frontend origin (allowlist; configurable via env so staging/prod can differ).
- Allowed headers: `Authorization`, `Content-Type`.
- Allowed methods: `GET`, `OPTIONS`.

This is a blocker for any non-localhost frontend dev / preview environment.

---

## Frontend fallback behavior (for backend awareness)

If `/facets` is not yet deployed, the frontend degrades gracefully: `getFacets` swallows the error, wholesaler options still load via `GET /wholesalers`, brand/category chips render empty until `/facets` ships. The product table itself continues to work via `/products`.

So the priority order is:

1. **CORS** — blocker for any cross-origin dev.
2. **Multi-value `brand` / `category`** — blocker for the filter bar UX.
3. **`/facets` endpoint** — blocker for chip counts, not for the table itself. Naive faceting acceptable for v1.
