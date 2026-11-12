# usagemeter

API usage metering + monetization engine: hashed API keys with per-key
plan quotas, idempotent usage-event ingestion, per-key / per-endpoint /
per-day aggregation, quota checks, and Stripe-ready billing exports —
in one local SQLite file, with **zero runtime dependencies** (Node 24
built-ins only: `node:sqlite`, `node:http`, `node:crypto`).

Part of the [Tytechlabs](https://www.linkedin.com/in/tahiryounas604)
open-source line. Open-core: this core is free (GPL-3.0); a hosted/pro
version may follow later.

## Features

- **API keys** — created keys are shown **once**; only their SHA-256
  hash (plus a short display prefix) is stored. Keys authenticate via
  `Authorization: Bearer <key>` or `X-Api-Key: <key>`, and can be
  revoked (a revoked key immediately stops authenticating).
- **Plans & quotas** — every key sits on a plan with a monthly unit
  quota: `free` 1,000 · `starter` 10,000 · `pro` 100,000 ·
  `enterprise` 1,000,000 units/month. A per-key custom quota overrides
  the plan default.
- **Idempotent ingestion** — `POST /events` accepts an idempotency key
  (`Idempotency-Key` header or `idempotencyKey` in the body). Replaying
  the same key for the same API key returns the original event with
  `duplicate: true` and **never double-counts** — enforced both in code
  and by a partial `UNIQUE` index in SQLite.
- **Aggregation** — rollups grouped by key / endpoint / day, plus a
  usage summary per key and month (totals, per-endpoint, per-day,
  quota, remaining).
- **Quota enforcement** — `GET /check?units=N` returns `200` when the
  caller's monthly quota covers the request and **`429`** when it does
  not. `POST /events` applies the same gate to new events, so usage
  past the quota is rejected, not silently recorded.
- **Billing export** — per-key monthly totals priced by plan
  (starter $0.002/unit, pro $0.001/unit, enterprise $0.0005/unit, free
  $0) exported as a **Stripe-style invoice draft (JSON)** or **CSV**.
- **CLI + HTTP server + library** — the same `MeterStore` powers all
  three, so the CLI, the API, and embedded use can never drift apart.

## Install

Requires **Node.js 24+** (uses the built-in `node:sqlite`).

```bash
git clone https://github.com/tahiryounas604/usagemeter.git
cd usagemeter
npm install
npm run build
```

No runtime dependencies — only TypeScript (dev) is installed.

## Usage

### Run the server

```bash
npm start -- serve                 # http://127.0.0.1:8787
USAGEMETER_PORT=9000 npm start -- serve
```

### HTTP API

```bash
# 1. Create a key (plaintext apiKey is returned ONCE — store it now)
curl -s -X POST localhost:8787/keys \
  -H 'content-type: application/json' \
  -d '{"name":"acme","plan":"starter"}'

# 2. Record usage (idempotent: replaying this request is safe)
curl -s -X POST localhost:8787/events \
  -H "authorization: Bearer um_live_…" \
  -H 'Idempotency-Key: req-123' \
  -H 'content-type: application/json' \
  -d '{"endpoint":"/v1/search","units":3}'

# 3. Pre-flight quota check (200 = allowed, 429 = quota exceeded)
curl -s "localhost:8787/check?units=1" -H "authorization: Bearer um_live_…"

# 4. Usage summary for the caller's key
curl -s localhost:8787/usage -H "authorization: Bearer um_live_…"
curl -s "localhost:8787/rollups?month=2026-11" -H "authorization: Bearer um_live_…"

# 5. Billing export for a month (Stripe-style JSON draft, or CSV)
curl -s "localhost:8787/billing/export?month=2026-11&format=json"
curl -s "localhost:8787/billing/export?month=2026-11&format=csv"
```

Endpoints: `POST /keys` · `GET /keys` · `POST /events` ·
`GET /check` · `GET /usage` · `GET /rollups` ·
`GET /billing/export` · `GET /health`.

### CLI

```bash
npm start -- create-key --name acme --plan starter   # prints the key once
npm start -- list-keys                               # prefixes only, never secrets
npm start -- ingest --api-key um_live_… --endpoint /v1/search --units 3 --idempotency-key req-123
npm start -- usage  --api-key um_live_…
npm start -- check  --api-key um_live_… --units 1    # exit 0 allowed, exit 2 over quota
npm start -- billing --month 2026-11 --format csv
npm start -- revoke-key <keyId>
```

### Library use

```ts
import { MeterStore } from "@tytechlabs/usagemeter";

const store = new MeterStore("./usagemeter.db");
const { record, apiKey } = store.createKey({ name: "acme", plan: "pro" });
store.ingest(record.id, { endpoint: "/v1/search", units: 3, idempotencyKey: "req-1" });
console.log(store.checkQuota(record.id, 1));       // { allowed: true, used: 3, … }
console.log(store.usageSummary(record.id, "2026-11"));
console.log(store.billingLines("2026-11"));
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `USAGEMETER_DIR` | `~/.usagemeter` | Directory for the DB |
| `USAGEMETER_DB` | `$DIR/usagemeter.db` | SQLite database path |
| `USAGEMETER_PORT` / `PORT` | `8787` | HTTP port |
| `USAGEMETER_HOST` | `127.0.0.1` | HTTP bind host |

## Architecture

```
src/
  types.ts       plans, key/event/summary/billing types
  keys.ts        key generation + SHA-256 hashing (node:crypto)
  validation.ts  input validation (endpoint, units, timestamps, months)
  db.ts          MeterStore — SQLite tables api_keys + events;
                 ingestion, rollups, summaries, quota, billing lines
  billing.ts     invoice-draft JSON + CSV rendering
  server.ts      node:http API (auth, 429 quota gate, exports)
  cli.ts         serve / create-key / ingest / usage / check / billing
  config.ts      env-based config
test/            node:test suites — keys, ingestion, aggregation,
                 quota, billing, server (loopback), CLI
```

Two SQLite tables do all the work. `api_keys` stores the SHA-256 hash,
display prefix, plan and quota — never a plaintext key. `events` stores
one row per accepted event with derived `day`/`month` columns, so
rollups and monthly quota checks are plain `GROUP BY` / `SUM` queries.
Idempotency is a partial unique index on
`(api_key_id, idempotency_key)`, so a duplicate cannot be stored even
if two identical requests race.

## Development

```bash
npm test          # node:test, runs on the TypeScript source directly
npm run build     # tsc -> dist/
npm run test:built  # build, then run the tests against the compiled output
```

## Honest limits

- **Not a hosted billing service.** The export is an invoice *draft*
  (Stripe-shaped JSON / CSV). v0.1 does not call the Stripe API, create
  real Stripe customers/invoices, or collect payment.
- **Key management endpoints are unauthenticated.** `POST /keys` and
  `GET /billing/export` have no admin auth in v0.1 — this is a
  local/self-hosted engine; run it behind your own gateway or on
  localhost (the default bind) and do not expose those routes publicly.
- **Quota is per calendar month (UTC)**, keyed off each event's
  timestamp. There are no rolling windows, per-endpoint quotas, or
  burst allowances in v0.1.
- **Pricing is a flat per-unit price per plan**, rounded to whole
  cents per key per month. No tiered/volume pricing, taxes, or credits.
- **Single-machine store.** SQLite is local; there is no multi-process
  or distributed metering, and no streaming/queue ingestion — events
  arrive over the HTTP API or the library/CLI.
- **Timestamps are trusted as sent.** A client can backdate an event
  into a previous month (it is then metered and billed in that month);
  v0.1 does not clamp timestamps to server time.

## License

GPL-3.0 — see [LICENSE](LICENSE).

## Author

Tahir Younas — Tytechlabs — https://www.linkedin.com/in/tahiryounas604
