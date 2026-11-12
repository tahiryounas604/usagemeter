/**
 * HTTP API (node:http, zero dependencies).
 *
 *   POST /keys            {name, plan?, monthlyQuota?}        -> 201 {id, apiKey (once), ...}
 *   GET  /keys            (list, hashes/prefixes only)
 *   POST /events          Authorization: Bearer <key> | X-Api-Key: <key>
 *                         {endpoint, units, timestamp?, idempotencyKey?}
 *                         Header: Idempotency-Key also accepted
 *                         -> 201 new | 200 duplicate | 401 bad key | 429 quota exceeded
 *   GET  /check?units=N   (key auth) -> 200 allowed | 429 quota exceeded
 *   GET  /usage?month=YYYY-MM  (key auth) -> usage summary for the caller's key
 *   GET  /billing/export?month=YYYY-MM&format=json|csv -> per-key invoice draft
 *   GET  /health          -> {ok:true}
 *
 * Note: /keys creation and /billing/export are unauthenticated in v0.1 —
 * this is a local/self-hosted engine; put it behind your own gateway.
 * See README "Honest limits".
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MeterStore } from "./db.ts";
import { toCsv, toInvoiceDraft } from "./billing.ts";
import { isPlanName } from "./types.ts";
import { ValidationError, monthOf } from "./validation.ts";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 64 * 1024) throw new ValidationError("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ValidationError("request body must be a JSON object");
  }
}

function extractApiKey(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const x = req.headers["x-api-key"];
  return typeof x === "string" ? x : null;
}

export function createMeterServer(store: MeterStore): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && path === "/keys") {
        const body = await readJson(req);
        const planRaw = body.plan;
        if (planRaw !== undefined && (typeof planRaw !== "string" || !isPlanName(planRaw))) {
          throw new ValidationError(`unknown plan: ${String(planRaw)}`);
        }
        const quotaRaw = body.monthlyQuota;
        if (quotaRaw !== undefined && typeof quotaRaw !== "number") throw new ValidationError("monthlyQuota must be a number");
        const created = store.createKey({
          name: body.name as string,
          ...(planRaw !== undefined ? { plan: planRaw as never } : {}),
          ...(quotaRaw !== undefined ? { monthlyQuota: quotaRaw as number } : {}),
        });
        sendJson(res, 201, { ...created.record, apiKey: created.apiKey });
        return;
      }

      if (method === "GET" && path === "/keys") {
        sendJson(res, 200, { keys: store.listKeys() });
        return;
      }

      if (method === "GET" && path === "/billing/export") {
        const month = url.searchParams.get("month") ?? monthOf(new Date());
        const format = url.searchParams.get("format") ?? "json";
        const lines = store.billingLines(month);
        if (format === "csv") {
          const csv = toCsv(lines);
          res.writeHead(200, { "content-type": "text/csv", "content-length": Buffer.byteLength(csv) });
          res.end(csv);
        } else if (format === "json") {
          sendJson(res, 200, toInvoiceDraft(lines, month));
        } else {
          throw new ValidationError("format must be json or csv");
        }
        return;
      }

      // Everything below requires a valid API key.
      const keyRecord = store.authenticate(extractApiKey(req));
      if (!keyRecord) {
        sendJson(res, 401, { error: "invalid or missing API key" });
        return;
      }

      if (method === "POST" && path === "/events") {
        const body = await readJson(req);
        const headerIdem = req.headers["idempotency-key"];
        const idem = (typeof headerIdem === "string" ? headerIdem : null) ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null);
        // Idempotent replay: return the original event, never double-count,
        // and never quota-block a replay of work already accepted.
        if (idem !== null) {
          const existing = store.findByIdempotency(keyRecord.id, idem);
          if (existing) {
            sendJson(res, 200, { event: existing, duplicate: true });
            return;
          }
        }
        // Quota gate for genuinely new events.
        const unitsRaw = body.units;
        if (typeof unitsRaw === "number" && Number.isInteger(unitsRaw) && unitsRaw >= 1) {
          const ts = typeof body.timestamp === "string" && !Number.isNaN(new Date(body.timestamp).getTime())
            ? new Date(body.timestamp).toISOString() : new Date().toISOString();
          const check = store.checkQuota(keyRecord.id, unitsRaw, ts.slice(0, 7));
          if (!check.allowed) {
            sendJson(res, 429, { error: "monthly quota exceeded", ...check });
            return;
          }
        }
        const result = store.ingest(keyRecord.id, {
          endpoint: body.endpoint as string,
          units: body.units as number,
          ...(typeof body.timestamp === "string" ? { timestamp: body.timestamp } : {}),
          idempotencyKey: idem,
        });
        sendJson(res, result.duplicate ? 200 : 201, { event: result.event, duplicate: result.duplicate });
        return;
      }

      if (method === "GET" && path === "/check") {
        const units = Number(url.searchParams.get("units") ?? "1");
        const month = url.searchParams.get("month") ?? monthOf(new Date());
        const check = store.checkQuota(keyRecord.id, Number.isInteger(units) && units >= 1 ? units : 1, month);
        sendJson(res, check.allowed ? 200 : 429, check);
        return;
      }

      if (method === "GET" && path === "/usage") {
        const month = url.searchParams.get("month") ?? monthOf(new Date());
        sendJson(res, 200, store.usageSummary(keyRecord.id, month));
        return;
      }

      if (method === "GET" && path === "/rollups") {
        const month = url.searchParams.get("month") ?? undefined;
        sendJson(res, 200, { rollups: store.rollups({ apiKeyId: keyRecord.id, ...(month ? { month } : {}) }) });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof ValidationError) {
        sendJson(res, 400, { error: err.message });
      } else {
        sendJson(res, 500, { error: "internal error" });
      }
    }
  });
}
