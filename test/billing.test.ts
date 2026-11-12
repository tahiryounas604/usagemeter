import test from "node:test";
import assert from "node:assert/strict";
import { memoryStore, NOV, OCT, T1 } from "./helpers.ts";
import { toCsv, toInvoiceDraft } from "../src/billing.ts";

function seeded() {
  const store = memoryStore();
  const starter = store.createKey({ name: "starter-co", plan: "starter" });
  const pro = store.createKey({ name: "pro-co", plan: "pro" });
  const idle = store.createKey({ name: "idle-co", plan: "pro" });
  store.ingest(starter.record.id, { endpoint: "/x", units: 1_000, timestamp: T1 });
  store.ingest(starter.record.id, { endpoint: "/y", units: 500, timestamp: T1 });
  store.ingest(pro.record.id, { endpoint: "/x", units: 3_000, timestamp: T1 });
  store.ingest(pro.record.id, { endpoint: "/x", units: 999_999, timestamp: OCT }); // other month: excluded
  return { store, starter, pro, idle };
}

test("billing: per-key totals and amounts are exact per plan pricing", () => {
  const { store, starter, pro } = seeded();
  try {
    const lines = store.billingLines(NOV);
    const byName = new Map(lines.map((l) => [l.keyName, l]));
    const s = byName.get("starter-co");
    assert.equal(s?.totalUnits, 1_500);
    assert.equal(s?.totalEvents, 2);
    assert.equal(s?.pricePerUnitUsd, 0.002);
    assert.equal(s?.amountUsd, 3.0); // 1500 * 0.002
    assert.equal(s?.apiKeyId, starter.record.id);
    const p = byName.get("pro-co");
    assert.equal(p?.totalUnits, 3_000);
    assert.equal(p?.amountUsd, 3.0); // 3000 * 0.001
    assert.equal(p?.apiKeyId, pro.record.id);
    assert.match(s?.description ?? "", /1500 units/);
  } finally { store.close(); }
});

test("billing: invoice draft totals, shape, and idle-key exclusion", () => {
  const { store } = seeded();
  try {
    const draft = toInvoiceDraft(store.billingLines(NOV), NOV);
    assert.equal(draft.currency, "usd");
    assert.equal(draft.month, NOV);
    assert.equal(draft.totalAmountUsd, 6.0);
    assert.equal(draft.lines.length, 2, "keys with zero usage are not billed");
    const line = draft.lines.find((l) => l.customerRef === "starter-co");
    assert.equal(line?.quantity, 1_500);
    assert.equal(line?.unitAmountUsd, 0.002);
    assert.equal(line?.amountUsd, 3.0);
    assert.equal(line?.metadata.plan, "starter");
    assert.equal(line?.metadata.month, NOV);
  } finally { store.close(); }
});

test("billing: CSV export has header, one row per key (incl. zero-usage), exact totals", () => {
  const { store } = seeded();
  try {
    const csv = toCsv(store.billingLines(NOV));
    const rows = csv.trimEnd().split("\n");
    assert.equal(rows[0], "api_key_id,key_name,key_prefix,plan,month,total_units,total_events,price_per_unit_usd,amount_usd,description");
    assert.equal(rows.length, 1 + 3);
    const starterRow = rows.find((r) => r.includes("starter-co"));
    assert.ok(starterRow?.includes(",1500,2,0.002,3.00,"));
    const idleRow = rows.find((r) => r.includes("idle-co"));
    assert.ok(idleRow?.includes(",0,0,0.001,0.00,"));
  } finally { store.close(); }
});

test("billing: free plan usage is metered but amounts to $0", () => {
  const store = memoryStore();
  try {
    const free = store.createKey({ name: "free-co", plan: "free" });
    store.ingest(free.record.id, { endpoint: "/x", units: 250, timestamp: T1 });
    const [line] = store.billingLines(NOV);
    assert.equal(line?.totalUnits, 250);
    assert.equal(line?.amountUsd, 0);
    const draft = toInvoiceDraft(store.billingLines(NOV), NOV);
    assert.equal(draft.totalAmountUsd, 0);
    assert.equal(draft.lines.length, 1, "free usage still appears as a $0 line");
  } finally { store.close(); }
});

test("billing: CSV escaping handles commas/quotes in key names", () => {
  const store = memoryStore();
  try {
    store.createKey({ name: 'weird, "co"', plan: "pro" });
    const csv = toCsv(store.billingLines(NOV));
    assert.ok(csv.includes('"weird, ""co"""'));
  } finally { store.close(); }
});
