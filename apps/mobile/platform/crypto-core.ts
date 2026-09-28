/** Shared UUIDv7 formatting; randomness comes from each platform's secure API. */
export function uuidv7(
  fillRandom: (bytes: Uint8Array) => void,
  timestamp = Date.now(),
): string {
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > 0xffffffffffff
  )
    throw new RangeError("UUID timestamp is outside the 48-bit range");
  const bytes = new Uint8Array(16);
  fillRandom(bytes);
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Math.floor(timestamp / 2 ** ((5 - index) * 8)) & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sha256Hex(digest: ArrayBuffer): string {
  if (digest.byteLength !== 32)
    throw new Error("Invalid SHA-256 digest length");
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
