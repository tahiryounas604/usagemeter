import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashApiKey, generateApiKey, keyPrefixOf, KEY_PREFIX } from "../src/keys.ts";
import { memoryStore } from "./helpers.ts";

test("keys: hashApiKey is plain SHA-256 hex of the plaintext", () => {
  const key = "um_live_example";
  assert.equal(hashApiKey(key), createHash("sha256").update(key, "utf8").digest("hex"));
  assert.match(hashApiKey(key), /^[0-9a-f]{64}$/);
  assert.notEqual(hashApiKey(key), hashApiKey(key + "x"));
});

test("keys: generated keys are unique, prefixed, and prefix helper is display-safe", () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.notEqual(a, b);
  assert.ok(a.startsWith(KEY_PREFIX));
  assert.ok(a.length >= KEY_PREFIX.length + 24);
  const prefix = keyPrefixOf(a);
  assert.ok(a.startsWith(prefix));
  assert.ok(prefix.length < a.length, "prefix must not reveal the full key");
});

test("keys: create stores no plaintext; authenticate round-trips; record has plan quota", () => {
  const store = memoryStore();
  try {
    const { record, apiKey } = store.createKey({ name: "acme", plan: "pro" });
    assert.equal(record.plan, "pro");
    assert.equal(record.monthlyQuota, 100_000);
    assert.equal(record.keyPrefix, keyPrefixOf(apiKey));
    assert.equal(record.revokedAt, null);
    // The record (as listed) must never contain the plaintext or its hash is fine to omit too.
    const listed = JSON.stringify(store.listKeys());
    assert.ok(!listed.includes(apiKey), "plaintext key must never appear in stored/listed records");
    const authed = store.authenticate(apiKey);
    assert.equal(authed?.id, record.id);
  } finally { store.close(); }
});

test("keys: default plan is free (quota 1000); custom quota overrides plan default", () => {
  const store = memoryStore();
  try {
    assert.equal(store.createKey({ name: "a" }).record.monthlyQuota, 1_000);
    assert.equal(store.createKey({ name: "b", plan: "free", monthlyQuota: 5 }).record.monthlyQuota, 5);
  } finally { store.close(); }
});

test("keys: wrong, empty, and revoked keys fail authentication", () => {
  const store = memoryStore();
  try {
    const { record, apiKey } = store.createKey({ name: "acme" });
    assert.equal(store.authenticate("um_live_wrong"), null);
    assert.equal(store.authenticate(""), null);
    assert.equal(store.authenticate(null), null);
    assert.equal(store.authenticate(undefined), null);
    assert.equal(store.authenticate(apiKey.slice(0, -1) + "x"), null);
    assert.equal(store.revokeKey(record.id), true);
    assert.equal(store.authenticate(apiKey), null, "revoked key must not authenticate");
    assert.equal(store.revokeKey(record.id), false, "second revoke is a no-op");
    assert.equal(store.revokeKey("no-such-id"), false);
  } finally { store.close(); }
});

test("keys: two keys for the same name are independent credentials", () => {
  const store = memoryStore();
  try {
    const a = store.createKey({ name: "acme" });
    const b = store.createKey({ name: "acme" });
    assert.notEqual(a.apiKey, b.apiKey);
    assert.notEqual(a.record.id, b.record.id);
    store.revokeKey(a.record.id);
    assert.equal(store.authenticate(b.apiKey)?.id, b.record.id);
  } finally { store.close(); }
});
