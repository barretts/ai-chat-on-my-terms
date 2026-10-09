// Original server/native failures are session-local. Never attach them to a
// serializable event: a schema clone must explicitly transfer this reference.
const causes = new WeakMap<object, unknown>();

export function retainLocalFailureCause(
  publicError: object,
  cause: unknown,
): void {
  causes.set(publicError, cause);
}

/** Unwrap only these weak mappings; Error.cause belongs to the error formatter. */
export function localFailureCause(error: object): unknown {
  let current: unknown = error;
  const visited = new Set<object>();
  while (
    current !== null &&
    (typeof current === "object" || typeof current === "function")
  ) {
    if (visited.has(current) || !causes.has(current)) return current;
    visited.add(current);
    current = causes.get(current);
  }
  return current;
}
