import test from "node:test";
import assert from "node:assert/strict";
import { MeterStore } from "../src/db.ts";
import { runCli } from "../src/cli.ts";
import { monthOf } from "../src/validation.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, outFn: (l: string) => out.push(l), errFn: (l: string) => err.push(l) };
}

test("cli: create-key prints the plaintext once; list-keys never prints it", async () => {
  const store = new MeterStore(":memory:");
  try {
    const c = capture();
    assert.equal(await runCli(["create-key", "--name", "cli-co", "--plan", "pro"], { store, out: c.outFn, errOut: c.errFn }), 0);
    const printed = c.out.join("\n");
    const m = printed.match(/um_live_\S+/);
    assert.ok(m, "create-key must print the plaintext key once");
    const apiKey = m[0];

    const c2 = capture();
    assert.equal(await runCli(["list-keys"], { store, out: c2.outFn, errOut: c2.errFn }), 0);
    assert.ok(!c2.out.join("\n").includes(apiKey), "list-keys must never print the plaintext");
    assert.match(c2.out.join("\n"), /cli-co/);

    const c3 = capture();
    assert.equal(await runCli(["ingest", "--api-key", apiKey, "--endpoint", "/x", "--units", "3"], { store, out: c3.outFn, errOut: c3.errFn }), 0);
    const c4 = capture();
    assert.equal(await runCli(["usage", "--api-key", apiKey], { store, out: c4.outFn, errOut: c4.errFn }), 0);
    assert.equal((JSON.parse(c4.out.join("\n")) as { totalUnits: number }).totalUnits, 3);
    assert.equal(monthOf(new Date()).length, 7);
  } finally { store.close(); }
});

test("cli: billing command emits a JSON invoice draft; bad key exits 1", async () => {
  const store = new MeterStore(":memory:");
  try {
    store.createKey({ name: "b-co", plan: "pro" });
    const c = capture();
    assert.equal(await runCli(["billing"], { store, out: c.outFn, errOut: c.errFn }), 0);
    const draft = JSON.parse(c.out.join("\n")) as { currency: string };
    assert.equal(draft.currency, "usd");
    const c2 = capture();
    assert.equal(await runCli(["usage", "--api-key", "um_live_wrong"], { store, out: c2.outFn, errOut: c2.errFn }), 1);
  } finally { store.close(); }
});
