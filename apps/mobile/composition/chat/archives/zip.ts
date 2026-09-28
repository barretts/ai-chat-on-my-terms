import { Unzip, UnzipInflate, zipSync } from "fflate";
import {
  ArchiveValidationError,
  validateArchiveEntries,
  type ZipEntry,
  type ZipPort,
} from "@locallab/archives";

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

/** Portable synchronous inflater is streamed in bounded chunks; expansion is counted before accumulation. */
export const mobileArchiveZip: ZipPort = {
  async encode(entries) {
    validateArchiveEntries(entries);
    return zipSync(
      Object.fromEntries(entries.map((entry) => [entry.path, entry.bytes])),
      { level: 6 },
    );
  },
  async decode(bytes) {
    if (bytes.byteLength > MAX_BYTES)
      throw new ArchiveValidationError("Archive exceeds the 512 MiB limit");
    const directory = readCentralDirectory(bytes);
    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    let total = 0;
    let finished = 0;
    let files = 0;
    let failure: Error | undefined;
    const unzip = new Unzip((file) => {
      const path = file.name.replaceAll("\\", "/");
      const declared = directory.get(path);
      if (!declared)
        throw new ArchiveValidationError(
          "ZIP file is missing from its directory",
        );
      // Directory entries are optional; they never create filesystem directories.
      if (path.endsWith("/")) {
        validateArchiveEntries([
          { path: path.slice(0, -1), bytes: new Uint8Array() },
        ]);
        return;
      }
      validateArchiveEntries([{ path, bytes: new Uint8Array() }]);
      if (names.has(path))
        throw new ArchiveValidationError("Duplicate archive entry");
      names.add(path);
      if (++files > MAX_ENTRIES)
        throw new ArchiveValidationError("Archive contains too many entries");
      if (
        file.originalSize !== undefined &&
        file.originalSize > MAX_BYTES - total
      )
        throw new ArchiveValidationError(
          "Archive exceeds the 512 MiB uncompressed limit",
        );
      const chunks: Uint8Array[] = [];
      let length = 0;
      let crc = 0xffffffff;
      file.ondata = (error, chunk, final) => {
        if (error) {
          failure = error;
          file.terminate();
          return;
        }
        total += chunk.byteLength;
        length += chunk.byteLength;
        if (total > MAX_BYTES || length > declared.size) {
          failure = new ArchiveValidationError(
            "Archive exceeds the 512 MiB uncompressed limit",
          );
          file.terminate();
          return;
        }
        for (const byte of chunk)
          crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
        chunks.push(chunk);
        if (final) {
          if (
            length !== declared.size ||
            (crc ^ 0xffffffff) >>> 0 !== declared.crc
          ) {
            failure = new ArchiveValidationError(
              "ZIP entry failed its integrity check",
            );
            file.terminate();
            return;
          }
          const data = new Uint8Array(length);
          let offset = 0;
          for (const part of chunks) {
            data.set(part, offset);
            offset += part.byteLength;
          }
          entries.push({ path, bytes: data });
          finished++;
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      const end = Math.min(offset + 16 * 1024, bytes.length);
      unzip.push(bytes.subarray(offset, end), end === bytes.length);
      if (failure) throw failure;
    }
    const declaredFiles = [...directory.keys()].filter(
      (path) => !path.endsWith("/"),
    ).length;
    if (!files || finished !== files || files !== declaredFiles)
      throw new ArchiveValidationError("ZIP is empty or incomplete");
    validateArchiveEntries(entries);
    return entries;
  },
};

/** ZIP32 central records supply expansion bounds and checksums before any inflater starts. */
function readCentralDirectory(
  bytes: Uint8Array,
): Map<string, { size: number; crc: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const invalid = () =>
    new ArchiveValidationError("ZIP directory is malformed or incomplete");
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65_557);
    offset--
  ) {
    if (
      u32(offset) === 0x06054b50 &&
      offset + 22 + u16(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw invalid();
  const count = u16(end + 10);
  const size = u32(end + 12);
  const start = u32(end + 16);
  if (
    u16(end + 4) !== 0 ||
    u16(end + 6) !== 0 ||
    u16(end + 8) !== count ||
    count > MAX_ENTRIES ||
    start + size !== end
  )
    throw invalid();
  const result = new Map<string, { size: number; crc: number }>();
  const ranges: Array<[number, number]> = [];
  const decoder = new TextDecoder();
  let offset = start;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw invalid();
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const compressed = u32(offset + 20);
    const uncompressed = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const local = u32(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      u16(offset + 34) !== 0 ||
      flags & 1 ||
      (method !== 0 && method !== 8) ||
      local + 30 > start
    )
      throw invalid();
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const path = decoder.decode(rawName).replaceAll("\\", "/");
    if (result.has(path))
      throw new ArchiveValidationError("Duplicate archive entry");
    validateArchiveEntries([
      {
        path: path.endsWith("/") ? path.slice(0, -1) : path,
        bytes: new Uint8Array(),
      },
    ]);
    if (
      u32(local) !== 0x04034b50 ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method
    )
      throw invalid();
    const localNameLength = u16(local + 26);
    const localExtraLength = u16(local + 28);
    const payload = local + 30 + localNameLength + localExtraLength;
    if (
      payload + compressed > start ||
      localNameLength !== nameLength ||
      !rawName.every(
        (byte, nameIndex) => bytes[local + 30 + nameIndex] === byte,
      )
    )
      throw invalid();
    expanded += uncompressed;
    if (expanded > MAX_BYTES)
      throw new ArchiveValidationError(
        "Archive exceeds the 512 MiB uncompressed limit",
      );
    result.set(path, { size: uncompressed, crc: u32(offset + 16) });
    ranges.push([local, payload + compressed]);
    offset = next;
  }
  if (offset !== end) throw invalid();
  ranges.sort((a, b) => a[0] - b[0]);
  if (
    ranges.some((range, index) => index > 0 && ranges[index - 1]![1] > range[0])
  )
    throw invalid();
  return result;
}
