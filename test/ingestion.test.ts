import test from "node:test";
import assert from "node:assert/strict";
import { memoryStore, T1 } from "./helpers.ts";
import { ValidationError } from "../src/validation.ts";

test("ingestion: a valid event is stored with derived day/month", () => {
  const store = memoryStore();
  try {
    const { record } = store.createKey({ name: "acme", plan: "pro" });
    const { event, duplicate } = store.ingest(record.id, { endpoint: "/v1/search", units: 3, timestamp: T1 });
    assert.equal(duplicate, false);
    assert.equal(event.apiKeyId, record.id);
    assert.equal(event.endpoint, "/v1/search");
    assert.equal(event.units, 3);
    assert.equal(event.day, "2026-11-10");
    assert.equal(event.month, "2026-11");
    assert.equal(event.idempotencyKey, null);
  } finally { store.close(); }
});

test("ingestion: missing timestamp defaults to now", () => {
  const store = memoryStore();
  try {
    const { record } = store.createKey({ name: "acme" });
    const before = new Date().toISOString().slice(0, 7);
    const { event } = store.ingest(record.id, { endpoint: "/x", units: 1 });
    assert.equal(event.month, before);
  } finally { store.close(); }
});

test("ingestion: duplicate idempotency key does NOT double-count", () => {
  const store = memoryStore();
  try {
    const { record } = store.createKey({ name: "acme", plan: "pro" });
    const first = store.ingest(record.id, { endpoint: "/v1/search", units: 5, timestamp: T1, idempotencyKey: "req-1" });
    const second = store.ingest(record.id, { endpoint: "/v1/search", units: 5, timestamp: T1, idempotencyKey: "req-1" });
    const third = store.ingest(record.id, { endpoint: "/v1/search", units: 999, timestamp: T1, idempotencyKey: "req-1" });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(third.duplicate, true);
    assert.equal(second.event.id, first.event.id, "replay returns the original event");
    assert.equal(third.event.units, 5, "replay returns original units, not the new payload");
    assert.equal(store.monthlyUnits(record.id, "2026-11"), 5);
    assert.equal(store.usageSummary(record.id, "2026-11").totalEvents, 1);
  } finally { store.close(); }
});

test("ingestion: same idempotency key under a DIFFERENT api key is independent", () => {
  const store = memoryStore();
  try {
    const a = store.createKey({ name: "a", plan: "pro" });
    const b = store.createKey({ name: "b", plan: "pro" });
    store.ingest(a.record.id, { endpoint: "/x", units: 2, timestamp: T1, idempotencyKey: "shared" });
    const rb = store.ingest(b.record.id, { endpoint: "/x", units: 7, timestamp: T1, idempotencyKey: "shared" });
    assert.equal(rb.duplicate, false);
    assert.equal(store.monthlyUnits(a.record.id, "2026-11"), 2);
    assert.equal(store.monthlyUnits(b.record.id, "2026-11"), 7);
  } finally { store.close(); }
});

test("ingestion: events without an idempotency key always count", () => {
  const store = memoryStore();
  try {
    const { record } = store.createKey({ name: "acme", plan: "pro" });
    store.ingest(record.id, { endpoint: "/x", units: 4, timestamp: T1 });
    store.ingest(record.id, { endpoint: "/x", units: 4, timestamp: T1 });
    assert.equal(store.monthlyUnits(record.id, "2026-11"), 8);
  } finally { store.close(); }
});

test("ingestion: validation rejects bad endpoint, units, timestamp, key state", () => {
  const store = memoryStore();
  try {
    const { record } = store.createKey({ name: "acme" });
    assert.throws(() => store.ingest(record.id, { endpoint: "", units: 1 }), ValidationError);
    assert.throws(() => store.ingest(record.id, { endpoint: "/x", units: 0 }), ValidationError);
    assert.throws(() => store.ingest(record.id, { endpoint: "/x", units: -3 }), ValidationError);
    assert.throws(() => store.ingest(record.id, { endpoint: "/x", units: 1.5 }), ValidationError);
    assert.throws(() => store.ingest(record.id, { endpoint: "/x", units: 1, timestamp: "not-a-date" }), ValidationError);
    assert.throws(() => store.ingest(record.id, { endpoint: "/x", units: 1, idempotencyKey: "" }), ValidationError);
    assert.throws(() => store.ingest("no-such-key", { endpoint: "/x", units: 1 }), ValidationError);
    assert.equal(store.monthlyUnits(record.id, "2026-11"), 0, "rejected events store nothing");
    store.revokeKey(record.id);
    assert.throws(() => store.ingest(record.id, { endpoint: "/x", units: 1 }), ValidationError);
  } finally { store.close(); }
});
