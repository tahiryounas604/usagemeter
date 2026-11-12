import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { MeterStore } from "../src/db.ts";
import { createMeterServer } from "../src/server.ts";
import { monthOf } from "../src/validation.ts";

async function withServer(fn: (base: string, store: MeterStore) => Promise<void>) {
  const store = new MeterStore(":memory:");
  const server = createMeterServer(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test("server: full flow — create key, ingest, duplicate, usage, billing", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const created = await fetch(`${base}/keys`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "http-co", plan: "starter" }),
    });
    assert.equal(created.status, 201);
    const keyBody = (await created.json()) as { id: string; apiKey: string; monthlyQuota: number };
    assert.ok(keyBody.apiKey.startsWith("um_live_"));
    assert.equal(keyBody.monthlyQuota, 10_000);
    const auth = { authorization: `Bearer ${keyBody.apiKey}`, "content-type": "application/json" };

    const ev = { endpoint: "/v1/search", units: 10, idempotencyKey: "http-1" };
    const first = await fetch(`${base}/events`, { method: "POST", headers: auth, body: JSON.stringify(ev) });
    assert.equal(first.status, 201);
    assert.equal(((await first.json()) as { duplicate: boolean }).duplicate, false);

    const replay = await fetch(`${base}/events`, { method: "POST", headers: auth, body: JSON.stringify(ev) });
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as { duplicate: boolean }).duplicate, true);

    const usage = await fetch(`${base}/usage`, { headers: auth });
    assert.equal(usage.status, 200);
    const usageBody = (await usage.json()) as { totalUnits: number; totalEvents: number };
    assert.equal(usageBody.totalUnits, 10, "duplicate must not double-count over HTTP either");
    assert.equal(usageBody.totalEvents, 1);

    const billing = await fetch(`${base}/billing/export?format=json`);
    assert.equal(billing.status, 200);
    const draft = (await billing.json()) as { totalAmountUsd: number; lines: { quantity: number }[] };
    assert.equal(draft.lines[0]?.quantity, 10);

    const csvRes = await fetch(`${base}/billing/export?format=csv`);
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(await csvRes.text(), /http-co/);
  });
});

test("server: auth failures are 401; header Idempotency-Key and X-Api-Key work", async () => {
  await withServer(async (base, store) => {
    const noAuth = await fetch(`${base}/events`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/x", units: 1 }),
    });
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(`${base}/usage`, { headers: { authorization: "Bearer um_live_nope" } });
    assert.equal(badAuth.status, 401);

    const { apiKey } = store.createKey({ name: "hdr-co", plan: "pro" });
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "idempotency-key": "hdr-1", "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/x", units: 2 }),
    });
    assert.equal(res.status, 201);
    const replay = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "idempotency-key": "hdr-1", "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "/x", units: 2 }),
    });
    assert.equal(replay.status, 200);
  });
});

test("server: quota — /check and POST /events both return 429 once the quota is exhausted", async () => {
  await withServer(async (base, store) => {
    const month = monthOf(new Date());
    const { apiKey, record } = store.createKey({ name: "tiny", monthlyQuota: 5 });
    const auth = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

    const okCheck = await fetch(`${base}/check?units=5`, { headers: auth });
    assert.equal(okCheck.status, 200);

    const fill = await fetch(`${base}/events`, { method: "POST", headers: auth, body: JSON.stringify({ endpoint: "/x", units: 5 }) });
    assert.equal(fill.status, 201);

    const deniedCheck = await fetch(`${base}/check?units=1`, { headers: auth });
    assert.equal(deniedCheck.status, 429);
    const deniedBody = (await deniedCheck.json()) as { allowed: boolean; used: number; quota: number };
    assert.equal(deniedBody.allowed, false);
    assert.equal(deniedBody.used, 5);
    assert.equal(deniedBody.quota, 5);

    const deniedEvent = await fetch(`${base}/events`, { method: "POST", headers: auth, body: JSON.stringify({ endpoint: "/x", units: 1 }) });
    assert.equal(deniedEvent.status, 429);
    assert.equal(store.monthlyUnits(record.id, month), 5, "rejected event must not be stored");
  });
});

test("server: validation errors are 400 and unknown routes are 404", async () => {
  await withServer(async (base, store) => {
    const { apiKey } = store.createKey({ name: "v", plan: "pro" });
    const auth = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    const bad = await fetch(`${base}/events`, { method: "POST", headers: auth, body: JSON.stringify({ endpoint: "/x", units: 0 }) });
    assert.equal(bad.status, 400);
    const badJson = await fetch(`${base}/events`, { method: "POST", headers: auth, body: "not json" });
    assert.equal(badJson.status, 400);
    const missing = await fetch(`${base}/nope`, { headers: auth });
    assert.equal(missing.status, 404);
    const badPlan = await fetch(`${base}/keys`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", plan: "gold" }),
    });
    assert.equal(badPlan.status, 400);
  });
});
