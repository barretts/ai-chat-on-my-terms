export interface MediaArtifact {
  kind: "image" | "video" | "unknown";
  mimeType: string;
  /** Milliseconds for animated content when determinable. */
  durationMs?: number;
}

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const u16be = (bytes: Uint8Array, p: number): number =>
  (bytes[p]! << 8) | bytes[p + 1]!;
const u16le = (bytes: Uint8Array, p: number): number =>
  bytes[p]! | (bytes[p + 1]! << 8);
const u32be = (bytes: Uint8Array, p: number): number =>
  (bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!;
const u32le = (bytes: Uint8Array, p: number): number =>
  bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16) | (bytes[p + 3]! << 24);
const u24le = (bytes: Uint8Array, p: number): number =>
  bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16);

function gifDuration(bytes: Uint8Array): number {
  let total = 0;
  for (let p = 0; p + 6 < bytes.length; p++) {
    if (bytes[p] === 0x21 && bytes[p + 1] === 0xf9 && bytes[p + 2] === 0x04) {
      const tenthMs = u16le(bytes, p + 4);
      total += (tenthMs === 0 ? 10 : tenthMs) * 10;
      p += 5;
    }
  }
  return total;
}

function mp4Duration(bytes: Uint8Array): number | undefined {
  const walk = (start: number, end: number): number | undefined => {
    for (let p = start; p + 8 <= end; ) {
      let size = u32be(bytes, p);
      const type = ascii(bytes, p + 4, 4);
      let body = p + 8;
      if (size === 1) {
        size = Number(
          (BigInt(u32be(bytes, p + 8)) << 32n) | BigInt(u32be(bytes, p + 12)),
        );
        body = p + 16;
      }
      if (size < 8 || p + size > end) break;
      if (type === "mvhd") {
        const version = bytes[body]!;
        if (version === 1) {
          const timescale = u32be(bytes, body + 20);
          const duration =
            (BigInt(u32be(bytes, body + 24)) << 32n) |
            BigInt(u32be(bytes, body + 28));
          return timescale > 0 ? Number((duration * 1000n) / BigInt(timescale)) : undefined;
        }
        const timescale = u32be(bytes, body + 12);
        const duration = u32be(bytes, body + 16);
        return timescale > 0 ? (duration * 1000) / timescale : undefined;
      }
      if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl") {
        const inner = walk(body, Math.min(end, p + size));
        if (inner !== undefined) return inner;
      }
      p += size;
    }
    return undefined;
  };
  return walk(0, bytes.length);
}

function webpDuration(bytes: Uint8Array): number | undefined {
  let iterations: number | undefined;
  let loopMs = 0;
  for (let p = 12; p + 8 <= bytes.length; ) {
    const fourcc = ascii(bytes, p, 4);
    const size = u32le(bytes, p + 4);
    const payload = p + 8;
    if (fourcc === "VP8X" && size >= 10) {
      const flags = bytes[payload]!;
      if ((flags & 0x02) === 0) return undefined;
      // Animation Iterations is the final 3 bytes of the VP8X payload.
      iterations = size >= 13 ? u24le(bytes, payload + size - 3) : 0;
    } else if (fourcc === "ANMF" && size >= 17) {
      loopMs += u24le(bytes, payload + 13);
    }
    p = payload + size + (size % 2);
  }
  if (iterations === undefined || loopMs === 0) return undefined;
  return loopMs * (iterations === 0 ? 1 : iterations + 1);
}

function pngArtifact(bytes: Uint8Array): MediaArtifact {
  let frames = 0;
  let durationMs = 0;
  for (let p = 8; p + 8 <= bytes.length; ) {
    const length = u32be(bytes, p);
    const type = ascii(bytes, p + 4, 4);
    const body = p + 8;
    if (type === "acTL") frames = u32be(bytes, body);
    else if (type === "fcTL") {
      const num = u16be(bytes, body + 20);
      const den = u16be(bytes, body + 22);
      if (den > 0) durationMs += (num * 1000) / den;
    }
    p = body + length + 4;
  }
  if (frames > 1) return { kind: "video", mimeType: "image/apng", durationMs };
  return { kind: "image", mimeType: "image/png" };
}

const extensionMime: Record<string, MediaArtifact> = {
  gif: { kind: "video", mimeType: "image/gif" },
  mp4: { kind: "video", mimeType: "video/mp4" },
  m4v: { kind: "video", mimeType: "video/mp4" },
  mov: { kind: "video", mimeType: "video/quicktime" },
  webm: { kind: "video", mimeType: "video/webm" },
  webp: { kind: "image", mimeType: "image/webp" },
  png: { kind: "image", mimeType: "image/png" },
  jpg: { kind: "image", mimeType: "image/jpeg" },
  jpeg: { kind: "image", mimeType: "image/jpeg" },
  bmp: { kind: "image", mimeType: "image/bmp" },
  txt: { kind: "unknown", mimeType: "application/octet-stream" },
};

/**
 * Recognize workflow-produced outputs (IM-13): image vs playable
 * video/GIF, with MIME and duration retained for previews.
 */
export function recognizeArtifact(filename: string, bytes: Uint8Array): MediaArtifact {
  const base = filename.toLowerCase().split(".").pop() ?? "";
  const byExtension = extensionMime[base];
  if (bytes.length >= 6 && ascii(bytes, 0, 4) === "GIF8")
    return { kind: "video", mimeType: "image/gif", durationMs: gifDuration(bytes) };
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    const durationMs = webpDuration(bytes);
    if (durationMs !== undefined)
      return { kind: "video", mimeType: "video/webp", durationMs };
    return { kind: "image", mimeType: "image/webp" };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    const mimeType = brand === "qt  " ? "video/quicktime" : "video/mp4";
    const durationMs = mp4Duration(bytes);
    return {
      kind: "video",
      mimeType,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  }
  if (bytes.length >= 8 && ascii(bytes, 0, 4) === "\x89PNG") return pngArtifact(bytes);
  return byExtension ?? { kind: "unknown", mimeType: "application/octet-stream" };
}
