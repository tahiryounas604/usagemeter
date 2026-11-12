import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeterStore } from "../src/db.ts";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "usagemeter-test-"));
}
export function memoryStore(): MeterStore {
  return new MeterStore(":memory:");
}
export const T1 = "2026-11-10T10:00:00.000Z";
export const T2 = "2026-11-10T15:30:00.000Z";
export const T3 = "2026-11-11T09:00:00.000Z";
export const OCT = "2026-10-05T09:00:00.000Z";
export const NOV = "2026-11";
