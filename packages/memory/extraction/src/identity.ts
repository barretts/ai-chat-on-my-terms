import { EntityIdSchema } from "@locallab/contracts/identity";
import type { MemoryScope } from "./types";

export function createMemoryId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const ms = Date.now();
  for (let index = 0; index < 6; index++) {
    bytes[index] = Math.floor(ms / 2 ** (8 * (5 - index))) & 0xff;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function checkedScope(value: MemoryScope): MemoryScope {
  if (!["global", "persona", "conversation"].includes(value.scope)) {
    throw new Error("Unknown memory scope");
  }
  if (value.scope === "global") {
    if (value.scopeId !== null)
      throw new Error("Global memory has no scope ID");
  } else EntityIdSchema.parse(value.scopeId);
  return { scope: value.scope, scopeId: value.scopeId };
}

export function scopeKey(value: MemoryScope): string {
  const scope = checkedScope(value);
  return `memory:${scope.scope}:${scope.scopeId ?? "global"}`;
}

/** Deterministic equality only; semantic facts are decided by the extraction model. */
export function normalizedContent(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}
