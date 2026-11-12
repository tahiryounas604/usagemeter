import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const KEY_PREFIX = "um_live_";

/** SHA-256 hex digest of a plaintext API key. Only this is ever stored. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Generate a new plaintext API key. Shown to the caller exactly once. */
export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

/** Display-safe prefix: scheme + first 6 secret chars. */
export function keyPrefixOf(plaintext: string): string {
  return plaintext.slice(0, KEY_PREFIX.length + 6);
}

/** Constant-time comparison of two hex digests (defence in depth). */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
