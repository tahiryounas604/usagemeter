import test from "node:test";
import assert from "node:assert/strict";
import { memoryStore, NOV, OCT, T1, T2, T3 } from "./helpers.ts";

function seeded() {
  const store = memoryStore();
  const { record } = store.createKey({ name: "acme", plan: "pro" });
  store.ingest(record.id, { endpoint: "/v1/search", units: 3, timestamp: T1 });
  store.ingest(record.id, { endpoint: "/v1/search", units: 2, timestamp: T2 }); // same day, same endpoint
  store.ingest(record.id, { endpoint: "/v1/chat", units: 10, timestamp: T1 });
  store.ingest(record.id, { endpoint: "/v1/search", units: 4, timestamp: T3 }); // next day
  store.ingest(record.id, { endpoint: "/v1/search", units: 100, timestamp: OCT }); // other month
  return { store, id: record.id };
}

test("aggregation: rollups group by key/endpoint/day with exact sums", () => {
  const { store, id } = seeded();
  try {
    const rows = store.rollups({ apiKeyId: id, month: NOV });
    assert.deepEqual(rows, [
      { apiKeyId: id, endpoint: "/v1/chat", day: "2026-11-10", events: 1, units: 10 },
      { apiKeyId: id, endpoint: "/v1/search", day: "2026-11-10", events: 2, units: 5 },
      { apiKeyId: id, endpoint: "/v1/search", day: "2026-11-11", events: 1, units: 4 },
    ]);
  } finally { store.close(); }
});

test("aggregation: usage summary totals, per-endpoint and per-day math are exact", () => {
  const { store, id } = seeded();
  try {
    const s = store.usageSummary(id, NOV);
    assert.equal(s.totalUnits, 19);
    assert.equal(s.totalEvents, 4);
    assert.equal(s.quota, 100_000);
    assert.equal(s.remaining, 100_000 - 19);
    assert.deepEqual(s.byEndpoint, [
      { endpoint: "/v1/chat", events: 1, units: 10 },
      { endpoint: "/v1/search", events: 3, units: 9 },
    ]);
    assert.deepEqual(s.byDay, [
      { day: "2026-11-10", events: 3, units: 15 },
      { day: "2026-11-11", events: 1, units: 4 },
    ]);
  } finally { store.close(); }
});

test("aggregation: months are isolated — October usage does not leak into November", () => {
  const { store, id } = seeded();
  try {
    assert.equal(store.monthlyUnits(id, "2026-10"), 100);
    assert.equal(store.monthlyUnits(id, NOV), 19);
    assert.equal(store.usageSummary(id, "2026-10").totalUnits, 100);
  } finally { store.close(); }
});

test("aggregation: keys are isolated from each other", () => {
  const store = memoryStore();
  try {
    const a = store.createKey({ name: "a", plan: "pro" });
    const b = store.createKey({ name: "b", plan: "pro" });
    store.ingest(a.record.id, { endpoint: "/x", units: 5, timestamp: T1 });
    store.ingest(b.record.id, { endpoint: "/x", units: 50, timestamp: T1 });
    assert.equal(store.usageSummary(a.record.id, NOV).totalUnits, 5);
    assert.equal(store.usageSummary(b.record.id, NOV).totalUnits, 50);
    assert.equal(store.rollups({ month: NOV }).length, 2);
  } finally { store.close(); }
});

test("aggregation: empty month gives a zeroed summary, remaining equals quota", () => {
  const store = memoryStore();
  try {
    const { record } = store.createKey({ name: "acme" });
    const s = store.usageSummary(record.id, NOV);
    assert.equal(s.totalUnits, 0);
    assert.equal(s.totalEvents, 0);
    assert.equal(s.remaining, 1_000);
    assert.deepEqual(s.byEndpoint, []);
    assert.deepEqual(s.byDay, []);
  } finally { store.close(); }
});
