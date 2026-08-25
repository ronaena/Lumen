# Lumen Backend — Developer Setup

Current status: a complete, acceptance-tested MVP backend. API layer, session-based
authentication, multi-format ebook ingestion (EPUB, TXT, DOCX, text-based PDF), TTS
provider abstraction (fixture-tested, no live provider calls), narration engine with
retry/fallback, audio delivery, progress tracking, and character/scene foundations are
all implemented and passing. A companion frontend (Vite + React + TypeScript) exists at
`../lumen-frontend`.

Not included: live TTS provider credentials/calls (ElevenLabs/Google Cloud adapters are
implemented and tested against injected HTTP fixtures only — no environment variable
anywhere reads a real provider API key), production object storage (only a
local-filesystem `StorageProvider`, explicitly dev/test-only), automatic
character/dialogue/scene detection (manual assignment only), legacy `.doc` support, OCR
for scanned/image-only PDFs, a production deployment entrypoint, payment/subscription
code, or approved real system voice definitions (`GET /voices` is implemented and
correct but returns `[]` until real, externally-verified vendor voice IDs are supplied —
see `src/db/seedSystemVoices.ts`).

## Requirements

- Node.js >= 22.6.0
- PostgreSQL (verified against 16.x)

## 1. Install dependencies

```bash
npm install
```

## 2. Configure the database connection

```bash
cp .env.example .env
# edit .env — DATABASE_URL must be a postgres:// or postgresql:// connection string
```

`DATABASE_URL` is validated at startup (`src/config/env.ts`) — a missing or malformed value
fails immediately with a clear error, not a late, opaque connection failure.

## 3. Create a fresh database and apply migrations

```bash
createdb lumen_dev   # or: psql -c "CREATE DATABASE lumen_dev;"
npm run db:migrate
```

This applies every file in `drizzle/` in order. Migrations are idempotent to rerun against an
already-migrated database (guarded with `IF NOT EXISTS`/`duplicate_object` handling in the
generated SQL) but are meant to be applied once, in order, to a target database.

Expected result: 19 tables. Verify with:

```bash
psql -d lumen_dev -c "\dt"
```

## 4. Run the test suite

Tests need their own database, separate from `lumen_dev`:

```bash
createdb lumen_test
DATABASE_URL=postgresql://localhost:5432/lumen_test npm run db:migrate
TEST_DATABASE_URL=postgresql://localhost:5432/lumen_test npm test
```

`TEST_DATABASE_URL` defaults to `postgresql://lumen:lumen@localhost:5432/lumen_test` if unset
(see `test/db/setup.ts`) — set it explicitly if your local Postgres uses different
credentials/host. Tests truncate their own tables between runs (`test/db/setup.ts`) and do not
depend on execution order or leftover state from a previous run.

## 5. Typecheck

```bash
npm run typecheck
```

## Verifying a completely fresh environment reproduces the baseline

```bash
dropdb lumen_test --if-exists && createdb lumen_test
DATABASE_URL=postgresql://localhost:5432/lumen_test npm run db:migrate
TEST_DATABASE_URL=postgresql://localhost:5432/lumen_test npm test
```

This should reproduce a fully passing suite against 19/19 tables, with every critical
constraint intact (constraint definitions live directly in `src/db/schema/*.ts` with
comments explaining the reasoning behind each one). Run `npm test` for the exact current
count rather than relying on a number written here, which will drift out of date as the
suite grows.

## API layer

20+ HTTP routes covering authentication, book upload/listing, chapters, segments,
characters, scenes, progress, and audio delivery — see `src/api/server.ts` for the
complete, current route table. Session-based bearer-token authentication; every route is
identity-gated by default except `/auth/register` and `/auth/login`.

## Frontend

A Vite + React + TypeScript single-page app lives in a sibling directory
(`../lumen-frontend`), consuming this API exclusively through `fetch`. It has no
knowledge of ebook source format — it only ever consumes the normalized
chapter/segment/audio representation this backend produces.
