# b2b-scrapers

Scrapes B2B wholesaler catalogs (naleo, kajasport, goldensneakers, brandsdistribution, brandsgateway, buy2bee, oversoles) into a Neon Postgres database via Drizzle ORM.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the env template and fill in your scraper credentials:
   ```bash
   cp .env.example .env
   # edit .env: set LOGIN / PASSWORD
   ```
3. Initialise the local database (creates `var/local.db`):
   ```bash
   npm run migrate
   ```
4. Optional — seed two snapshots so the API has something to return:
   ```bash
   npm run seed
   ```

## Environments

Three env files, all gitignored except the example:

| File              | Purpose             | DB target                                          |
| ----------------- | ------------------- | -------------------------------------------------- |
| `.env`            | local dev (default) | local Postgres or PGlite                           |
| `.env.staging`    | staging Neon branch | `postgres://…@<branch>-pooler.neon.tech/b2b_scrapers` |
| `.env.production` | production Neon     | `postgres://…@<branch>-pooler.neon.tech/b2b_scrapers` |

## Scripts

| Command                   | Effect                                            |
| ------------------------- | ------------------------------------------------- |
| `npm run scrape`          | Run scraper against local DB (`.env`).            |
| `npm run scrape:staging`  | Run scraper against staging (`.env.staging`).     |
| `npm run scrape:prod`     | Run scraper against production (`.env.production`). |
| `npm run api`             | Start Hono API against local DB.                  |
| `npm run api:staging`     | API against staging DB.                           |
| `npm run migrate`         | Apply `db/schema.sql` to local DB.                |
| `npm run migrate:staging` | Apply schema to staging Turso DB.                 |
| `npm run migrate:prod`    | Apply schema to production Turso DB.              |
| `npm run seed`            | Insert demo product + two snapshots locally.      |
| `npm run db:reset`        | Wipe `var/local.db*`, re-migrate, re-seed.        |
| `npm run test`            | Vitest suite (in-memory DB, no env needed).       |
| `npm run typecheck`       | `tsc --noEmit`.                                   |

Migrations are idempotent (`IF NOT EXISTS` everywhere) — safe to re-run against any env.

API documentation: with the server running (`npm run api`), open http://localhost:3000/docs for Swagger UI or http://localhost:3000/openapi.json for the raw spec.

## API keys

Data endpoints (`/wholesalers`, `/products`, `/deals`) require a publishable `pk_…` key passed as `Authorization: Bearer <key>`. `/docs` and `/openapi.json` stay open. Manage keys via CLI: `npm run keys:create -- "frontend-prod"` prints a new key once, `npm run keys:list` shows all keys, `npm run keys:revoke -- <id>` revokes one (cache TTL is 60s). In Swagger UI click "Authorize" and paste the key to try requests in the browser.

## CI

`.github/workflows/scrape.yml` runs scheduled scrapes against the Turso DB configured in repo secrets (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `LOGIN`, `PASSWORD`). No `.env` file in CI — secrets are injected directly into the process env.
