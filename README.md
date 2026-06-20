# b2b-naleo-scraper

Scrapes B2B wholesaler catalogs into a libsql/Turso database and exposes a Hono API for downstream consumers. Currently wired to `b2b-naleo.pl`.

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

| File              | Purpose                  | DB target                          |
| ----------------- | ------------------------ | ---------------------------------- |
| `.env`            | local dev (default)      | `file:./var/local.db`              |
| `.env.staging`    | staging Turso DB         | `libsql://<db>-<org>.turso.io`     |
| `.env.production` | production Turso DB      | `libsql://<db>-<org>.turso.io`     |

Get Turso URL + token via:
```bash
turso db create naleo-staging
turso db show naleo-staging --url
turso db tokens create naleo-staging
```

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

## CI

`.github/workflows/scrape.yml` runs scheduled scrapes against the Turso DB configured in repo secrets (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `LOGIN`, `PASSWORD`). No `.env` file in CI — secrets are injected directly into the process env.
