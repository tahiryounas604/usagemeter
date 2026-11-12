import test from "node:test";
import assert from "node:assert/strict";
import { memoryStore, NOV, OCT, T1 } from "./helpers.ts";

test("quota: under quota is allowed with exact used/remaining", () => {
  const store = memoryStore();
  try {
    const { record } = store.createKey({ name: "acme", plan: "free", monthlyQuota: 10 });
    store.ingest(record.id, { endpoint: "/x", units: 4, timestamp: T1 });
    const c = store.checkQuota(record.id, 6, NOV);
    assert.equal(c.allowed, true);
    assert.equal(c.used, 4);
    assert.equal(c.quota, 10);
    assert.equal(c.remaining, 6);
    assert.equal(c.requested, 6);
  } finally { store.close(); }
});

test("quota: exactly at quota is allowed; one unit over is denied", () => {
  const store = memoryStore();
  try {
    const { record } = store.createKey({ name: "acme", monthlyQuota: 10 });
    store.ingest(record.id, { endpoint: "/x", units: 9, timestamp: T1 });
    assert.equal(store.checkQuota(record.id, 1, NOV).allowed, true);
    assert.equal(store.checkQuota(record.id, 2, NOV).allowed, false);
    store.ingest(record.id, { endpoint: "/x", units: 1, timestamp: T1 });
    const full = store.checkQuota(record.id, 1, NOV);
    assert.equal(full.allowed, false);
    assert.equal(full.used, 10);
    assert.equal(full.remaining, 0);
  } finally { store.close(); }
});

test("quota: a new month resets usage", () => {
  const store = memoryStore();
  try {
    const { record } = store.createKey({ name: "acme", monthlyQuota: 5 });
    store.ingest(record.id, { endpoint: "/x", units: 5, timestamp: OCT });
    assert.equal(store.checkQuota(record.id, 1, "2026-10").allowed, false);
    assert.equal(store.checkQuota(record.id, 5, NOV).allowed, true);
    assert.equal(store.checkQuota(record.id, 5, NOV).used, 0);
  } finally { store.close(); }
});

test("quota: plan defaults apply (free=1000) and zero-quota keys allow nothing", () => {
  const store = memoryStore();
  try {
    const free = store.createKey({ name: "f" });
    assert.equal(free.record.monthlyQuota, 1_000);
    assert.equal(store.checkQuota(free.record.id, 1_000, NOV).allowed, true);
    assert.equal(store.checkQuota(free.record.id, 1_001, NOV).allowed, false);
    const zero = store.createKey({ name: "z", monthlyQuota: 0 });
    assert.equal(store.checkQuota(zero.record.id, 1, NOV).allowed, false);
  } finally { store.close(); }
});

test("quota: checkQuota validates its inputs", () => {
  const store = memoryStore();
  try {
    const { record } = store.createKey({ name: "acme" });
    assert.throws(() => store.checkQuota(record.id, 0, NOV));
    assert.throws(() => store.checkQuota(record.id, 1.5, NOV));
    assert.throws(() => store.checkQuota(record.id, 1, "2026-13"));
    assert.throws(() => store.checkQuota("nope", 1, NOV));
  } finally { store.close(); }
});
