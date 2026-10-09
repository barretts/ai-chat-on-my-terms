/**
 * Expo permits only letters, digits, dots, hyphens and underscores in keys.
 * Escape every other UTF-16 code unit, including underscores, so the mapping
 * is reversible and cannot alias a literal escape sequence in another key.
 * This changes OS key names only; opaque refs and the shared store stay stable.
 */
export function expoSecureStoreKey(key: string): string {
  return key.replace(
    /[^A-Za-z0-9.-]/g,
    (character) => `_${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
