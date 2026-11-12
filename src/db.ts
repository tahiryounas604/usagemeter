/**
 * Metering store backed by SQLite (Node 24 built-in `node:sqlite`).
 * Tables: api_keys (hash only, never plaintext) and events (one row per
 * accepted usage event; UNIQUE(api_key_id, idempotency_key) enforces
 * idempotent ingestion at the database level too).
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { generateApiKey, hashApiKey, keyPrefixOf } from "./keys.ts";
import { PLANS, isPlanName, type ApiKeyRecord, type BillingLine, type CreatedKey, type IngestResult, type PlanName, type QuotaCheck, type RollupRow, type UsageEvent, type UsageEventInput, type UsageSummary } from "./types.ts";
import { ValidationError, monthOf, validateEndpoint, validateKeyName, validateMonth, validateTimestamp, validateUnits } from "./validation.ts";

function rowToKey(row: Record<string, unknown>): ApiKeyRecord {
  const plan = String(row.plan);
  if (!isPlanName(plan)) throw new Error(`corrupt row: unknown plan ${plan}`);
  return {
    id: String(row.id),
    name: String(row.name),
    keyPrefix: String(row.key_prefix),
    plan,
    monthlyQuota: Number(row.monthly_quota),
    createdAt: String(row.created_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
  };
}

function rowToEvent(row: Record<string, unknown>): UsageEvent {
  return {
    id: String(row.id),
    apiKeyId: String(row.api_key_id),
    endpoint: String(row.endpoint),
    units: Number(row.units),
    timestamp: String(row.timestamp),
    day: String(row.day),
    month: String(row.month),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    createdAt: String(row.created_at),
  };
}

export class MeterStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        plan TEXT NOT NULL,
        monthly_quota INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        api_key_id TEXT NOT NULL REFERENCES api_keys(id),
        endpoint TEXT NOT NULL,
        units INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        day TEXT NOT NULL,
        month TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem
        ON events (api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_events_rollup
        ON events (api_key_id, month, endpoint, day);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- API keys -------------------------------------------------------

  createKey(input: { name: string; plan?: PlanName; monthlyQuota?: number }, now: Date = new Date()): CreatedKey {
    const name = validateKeyName(input.name);
    const plan: PlanName = input.plan ?? "free";
    if (!isPlanName(plan)) throw new ValidationError(`unknown plan: ${String(input.plan)}`);
    const quota = input.monthlyQuota ?? PLANS[plan].monthlyQuota;
    if (!Number.isInteger(quota) || quota < 0) throw new ValidationError("monthlyQuota must be a non-negative integer");
    const apiKey = generateApiKey();
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name,
      keyPrefix: keyPrefixOf(apiKey),
      plan,
      monthlyQuota: quota,
      createdAt: now.toISOString(),
      revokedAt: null,
    };
    this.db.prepare(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, plan, monthly_quota, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(record.id, record.name, hashApiKey(apiKey), record.keyPrefix, record.plan, record.monthlyQuota, record.createdAt);
    return { record, apiKey };
  }

  /** Authenticate a plaintext key. Returns null for unknown/revoked keys. */
  authenticate(plaintext: string | null | undefined): ApiKeyRecord | null {
    if (!plaintext) return null;
    const row = this.db.prepare(`SELECT * FROM api_keys WHERE key_hash = ?`).get(hashApiKey(plaintext)) as Record<string, unknown> | undefined;
    if (!row) return null;
    const rec = rowToKey(row);
    return rec.revokedAt === null ? rec : null;
  }

  getKey(id: string): ApiKeyRecord | null {
    const row = this.db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToKey(row) : null;
  }

  listKeys(): ApiKeyRecord[] {
    return (this.db.prepare(`SELECT * FROM api_keys ORDER BY created_at, id`).all() as Record<string, unknown>[]).map(rowToKey);
  }

  revokeKey(id: string, now: Date = new Date()): boolean {
    const res = this.db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now.toISOString(), id);
    return Number(res.changes) > 0;
  }

  // ---- Ingestion ------------------------------------------------------

  ingest(apiKeyId: string, input: UsageEventInput, now: Date = new Date()): IngestResult {
    const key = this.getKey(apiKeyId);
    if (!key) throw new ValidationError(`unknown api key id: ${apiKeyId}`);
    if (key.revokedAt !== null) throw new ValidationError("api key is revoked");
    const endpoint = validateEndpoint(input.endpoint);
    const units = validateUnits(input.units);
    const timestamp = validateTimestamp(input.timestamp, now);
    const idem = input.idempotencyKey ?? null;
    if (idem !== null) {
      if (typeof idem !== "string" || idem.length === 0 || idem.length > 200) {
        throw new ValidationError("idempotencyKey must be a non-empty string <= 200 chars");
      }
      const existing = this.db.prepare(
        `SELECT * FROM events WHERE api_key_id = ? AND idempotency_key = ?`,
      ).get(apiKeyId, idem) as Record<string, unknown> | undefined;
      if (existing) return { event: rowToEvent(existing), duplicate: true };
    }
    const event: UsageEvent = {
      id: randomUUID(),
      apiKeyId,
      endpoint,
      units,
      timestamp,
      day: timestamp.slice(0, 10),
      month: timestamp.slice(0, 7),
      idempotencyKey: idem,
      createdAt: now.toISOString(),
    };
    this.db.prepare(
      `INSERT INTO events (id, api_key_id, endpoint, units, timestamp, day, month, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(event.id, event.apiKeyId, event.endpoint, event.units, event.timestamp, event.day, event.month, event.idempotencyKey, event.createdAt);
    return { event, duplicate: false };
  }

  findByIdempotency(apiKeyId: string, idempotencyKey: string): UsageEvent | null {
    const row = this.db.prepare(
      `SELECT * FROM events WHERE api_key_id = ? AND idempotency_key = ?`,
    ).get(apiKeyId, idempotencyKey) as Record<string, unknown> | undefined;
    return row ? rowToEvent(row) : null;
  }

  // ---- Aggregation & quota -------------------------------------------

  monthlyUnits(apiKeyId: string, month: string): number {
    validateMonth(month);
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(units), 0) AS total FROM events WHERE api_key_id = ? AND month = ?`,
    ).get(apiKeyId, month) as Record<string, unknown>;
    return Number(row.total);
  }

  rollups(filter: { apiKeyId?: string; month?: string } = {}): RollupRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.apiKeyId) { where.push("api_key_id = ?"); params.push(filter.apiKeyId); }
    if (filter.month) { validateMonth(filter.month); where.push("month = ?"); params.push(filter.month); }
    const sql = `SELECT api_key_id, endpoint, day, COUNT(*) AS events, SUM(units) AS units FROM events
      ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY api_key_id, endpoint, day ORDER BY day, endpoint`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => ({
      apiKeyId: String(r.api_key_id), endpoint: String(r.endpoint), day: String(r.day),
      events: Number(r.events), units: Number(r.units),
    }));
  }

  usageSummary(apiKeyId: string, month: string = monthOf(new Date())): UsageSummary {
    validateMonth(month);
    const key = this.getKey(apiKeyId);
    if (!key) throw new ValidationError(`unknown api key id: ${apiKeyId}`);
    const byEndpoint = (this.db.prepare(
      `SELECT endpoint, COUNT(*) AS events, SUM(units) AS units FROM events WHERE api_key_id = ? AND month = ? GROUP BY endpoint ORDER BY endpoint`,
    ).all(apiKeyId, month) as Record<string, unknown>[]).map((r) => ({ endpoint: String(r.endpoint), events: Number(r.events), units: Number(r.units) }));
    const byDay = (this.db.prepare(
      `SELECT day, COUNT(*) AS events, SUM(units) AS units FROM events WHERE api_key_id = ? AND month = ? GROUP BY day ORDER BY day`,
    ).all(apiKeyId, month) as Record<string, unknown>[]).map((r) => ({ day: String(r.day), events: Number(r.events), units: Number(r.units) }));
    const totalUnits = byEndpoint.reduce((s, r) => s + r.units, 0);
    const totalEvents = byEndpoint.reduce((s, r) => s + r.events, 0);
    return {
      apiKeyId, month, totalUnits, totalEvents,
      quota: key.monthlyQuota,
      remaining: Math.max(0, key.monthlyQuota - totalUnits),
      byEndpoint, byDay,
    };
  }

  checkQuota(apiKeyId: string, requested: number = 1, month: string = monthOf(new Date())): QuotaCheck {
    validateMonth(month);
    if (!Number.isInteger(requested) || requested < 1) throw new ValidationError("requested units must be a positive integer");
    const key = this.getKey(apiKeyId);
    if (!key) throw new ValidationError(`unknown api key id: ${apiKeyId}`);
    const used = this.monthlyUnits(apiKeyId, month);
    const remaining = Math.max(0, key.monthlyQuota - used);
    return { allowed: used + requested <= key.monthlyQuota, apiKeyId, month, used, quota: key.monthlyQuota, remaining, requested };
  }

  // ---- Billing --------------------------------------------------------

  billingLines(month: string = monthOf(new Date())): BillingLine[] {
    validateMonth(month);
    const rows = this.db.prepare(
      `SELECT k.id AS kid, k.name AS kname, k.key_prefix AS kprefix, k.plan AS kplan,
              COUNT(e.id) AS events, COALESCE(SUM(e.units), 0) AS units
       FROM api_keys k LEFT JOIN events e ON e.api_key_id = k.id AND e.month = ?
       GROUP BY k.id ORDER BY k.name, k.id`,
    ).all(month) as Record<string, unknown>[];
    return rows.map((r) => {
      const plan = String(r.kplan) as PlanName;
      const units = Number(r.units);
      const price = PLANS[plan].pricePerUnitUsd;
      const amountUsd = Math.round(units * price * 100) / 100;
      const name = String(r.kname);
      return {
        apiKeyId: String(r.kid), keyName: name, keyPrefix: String(r.kprefix), plan, month,
        totalUnits: units, totalEvents: Number(r.events), pricePerUnitUsd: price, amountUsd,
        description: `API usage for ${name} (${month}): ${units} units on ${plan} plan`,
      };
    });
  }
}
