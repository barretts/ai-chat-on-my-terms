import { File, FileMode } from "expo-file-system";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export interface AssetInspection {
  byteLength: number;
  sha256: string;
  prefix: Uint8Array;
}

/** Small header read only. Large model SHA scans are deliberately opt-out. */
export function inspectAssetHeader(
  uri: string,
  signal?: AbortSignal,
): { byteLength: number; prefix: Uint8Array } {
  signal?.throwIfAborted();
  const file = new File(uri);
  if (!file.exists) throw new Error("The downloaded file is missing.");
  const handle = file.open(FileMode.ReadOnly);
  try {
    return { byteLength: file.size, prefix: handle.readBytes(32) };
  } finally {
    handle.close();
  }
}

/** Verify large native files without loading model weights into the JavaScript heap. */
export async function inspectAssetFile(
  uri: string,
  signal?: AbortSignal,
  onProgress?: (bytes: number) => void,
): Promise<AssetInspection> {
  signal?.throwIfAborted();
  const file = new File(uri);
  if (!file.exists) throw new Error("The downloaded file is missing.");
  const handle = file.open();
  const digest = sha256.create();
  let byteLength = 0;
  let prefix = new Uint8Array();
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = handle.readBytes(4 * 1024 * 1024);
      if (!chunk.length) break;
      if (!byteLength) prefix = chunk.slice(0, 32);
      digest.update(chunk);
      byteLength += chunk.length;
      onProgress?.(byteLength);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    signal?.throwIfAborted();
    return { byteLength, sha256: bytesToHex(digest.digest()), prefix };
  } finally {
    handle.close();
    digest.destroy();
  }
}
