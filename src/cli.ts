#!/usr/bin/env node
/**
 * usagemeter CLI.
 *   serve [--port N] [--host H]
 *   create-key --name <name> [--plan free|starter|pro|enterprise] [--quota N]
 *   list-keys
 *   revoke-key <keyId>
 *   ingest --api-key <plaintext> --endpoint </path> --units N [--idempotency-key K] [--timestamp ISO]
 *   usage --api-key <plaintext> [--month YYYY-MM]
 *   check --api-key <plaintext> [--units N] [--month YYYY-MM]
 *   billing [--month YYYY-MM] [--format json|csv]
 */
import { MeterStore } from "./db.ts";
import { createMeterServer } from "./server.ts";
import { loadConfig } from "./config.ts";
import { toCsv, toInvoiceDraft } from "./billing.ts";
import { isPlanName, type PlanName } from "./types.ts";
import { ValidationError, monthOf } from "./validation.ts";

export interface CliDeps {
  store: MeterStore;
  out: (line: string) => void;
  errOut: (line: string) => void;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function authed(store: MeterStore, args: string[]) {
  const plaintext = flag(args, "--api-key") ?? process.env.USAGEMETER_API_KEY;
  const rec = store.authenticate(plaintext);
  if (!rec) throw new ValidationError("invalid or missing --api-key");
  return rec;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { store, out, errOut } = deps;
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "serve": {
        const config = loadConfig();
        const port = Number(flag(args, "--port") ?? config.port);
        const host = flag(args, "--host") ?? config.host;
        const server = createMeterServer(store);
        await new Promise<void>((resolve) => server.listen(port, host, resolve));
        out(`usagemeter listening on http://${host}:${port} (db: ${config.dbPath})`);
        await new Promise<void>(() => undefined); // run until killed
        return 0;
      }
      case "create-key": {
        const name = flag(args, "--name");
        if (!name) throw new ValidationError("--name is required");
        const planRaw = flag(args, "--plan");
        if (planRaw !== undefined && !isPlanName(planRaw)) throw new ValidationError(`unknown plan: ${planRaw}`);
        const quotaRaw = flag(args, "--quota");
        const created = store.createKey({
          name,
          ...(planRaw ? { plan: planRaw as PlanName } : {}),
          ...(quotaRaw ? { monthlyQuota: Number(quotaRaw) } : {}),
        });
        out(`id: ${created.record.id}`);
        out(`name: ${created.record.name}`);
        out(`plan: ${created.record.plan} (monthly quota: ${created.record.monthlyQuota})`);
        out(`apiKey (shown once, store it now): ${created.apiKey}`);
        return 0;
      }
      case "list-keys": {
        const keys = store.listKeys();
        if (hasFlag(args, "--json")) { out(JSON.stringify(keys, null, 2)); return 0; }
        if (keys.length === 0) { out("no keys"); return 0; }
        for (const k of keys) out(`${k.id}  ${k.keyPrefix}…  ${k.name}  plan=${k.plan} quota=${k.monthlyQuota}${k.revokedAt ? " REVOKED" : ""}`);
        return 0;
      }
      case "revoke-key": {
        const id = args[0];
        if (!id) throw new ValidationError("usage: revoke-key <keyId>");
        out(store.revokeKey(id) ? `revoked ${id}` : `not revoked (unknown id or already revoked)`);
        return 0;
      }
      case "ingest": {
        const rec = authed(store, args);
        const endpoint = flag(args, "--endpoint");
        const units = Number(flag(args, "--units") ?? "1");
        if (!endpoint) throw new ValidationError("--endpoint is required");
        const result = store.ingest(rec.id, {
          endpoint, units,
          ...(flag(args, "--timestamp") ? { timestamp: flag(args, "--timestamp") as string } : {}),
          idempotencyKey: flag(args, "--idempotency-key") ?? null,
        });
        out(JSON.stringify(result));
        return 0;
      }
      case "usage": {
        const rec = authed(store, args);
        out(JSON.stringify(store.usageSummary(rec.id, flag(args, "--month") ?? monthOf(new Date())), null, 2));
        return 0;
      }
      case "check": {
        const rec = authed(store, args);
        const check = store.checkQuota(rec.id, Number(flag(args, "--units") ?? "1"), flag(args, "--month") ?? monthOf(new Date()));
        out(JSON.stringify(check));
        return check.allowed ? 0 : 2;
      }
      case "billing": {
        const month = flag(args, "--month") ?? monthOf(new Date());
        const format = flag(args, "--format") ?? "json";
        const lines = store.billingLines(month);
        out(format === "csv" ? toCsv(lines).trimEnd() : JSON.stringify(toInvoiceDraft(lines, month), null, 2));
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
        out("usage: usagemeter <serve|create-key|list-keys|revoke-key|ingest|usage|check|billing> [options]");
        return 0;
      default:
        errOut(`unknown command: ${cmd}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof ValidationError) { errOut(`error: ${err.message}`); return 1; }
    throw err;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const config = loadConfig();
  const store = new MeterStore(config.dbPath);
  try {
    const code = await runCli(process.argv.slice(2), {
      store,
      out: (l) => console.log(l),
      errOut: (l) => console.error(l),
    });
    if (process.argv[2] !== "serve") { store.close(); process.exit(code); }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
