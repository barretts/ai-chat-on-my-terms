/** The package's one canonical object-shape guard (standalone package; no
 * shared type-guard module in the workspace). Fields stay `unknown`; callers
 * must still check the properties they consume with typeof/Array.isArray/in. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
