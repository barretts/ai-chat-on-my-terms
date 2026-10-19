import { createMobileArchivePorts } from "./index";
import { mobileArchiveZip } from "./zip";
import { browserArchivePdf } from "./pdf.web";
import { pickBrowserFile } from "../attachments-browser";
import type {
  ArchiveFilePort,
  MobileArchiveOptions,
  MobileArchivePorts,
} from "./types";
import {
  desktopInvoke,
  isDesktopBridge,
} from "../../../platform/desktop/bridge";
import { bytesToBase64 } from "../../../platform/desktop/encoding";

/** Browser exports download actual bytes; imports use the system file chooser. */
export const nativeArchiveFiles: ArchiveFilePort = {
  async pick(kind, maxBytes) {
    const file = await pickBrowserFile(
      kind === "json"
        ? ".json,application/json,text/json,text/plain"
        : ".zip,application/zip,application/x-zip-compressed",
    );
    if (!file) return undefined;
    if (file.size > maxBytes)
      throw new Error("Selected archive exceeds the supported size limit");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > maxBytes)
      throw new Error("Selected archive exceeds the supported size limit");
    return bytes;
  },
  async share({ name, mimeType, bytes }) {
    if (!/^[A-Za-z0-9_.-]{1,255}$/.test(name) || name === "." || name === "..")
      throw new Error("Export filename is invalid");
    if (isDesktopBridge()) {
      // Tauri shell: native save dialog writes the bytes itself (Rust rfd);
      // `defaultDir: null` lets the OS choose the folder. None = user canceled.
      await desktopInvoke<string | null>("files_save", {
        name,
        base64Data: bytesToBase64(bytes),
        defaultDir: null,
      });
      return;
    }
    const uri = URL.createObjectURL(
      new Blob([Uint8Array.from(bytes)], { type: mimeType }),
    );
    const link = document.createElement("a");
    link.href = uri;
    link.download = name;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      // Let the browser acquire the download before releasing its URL.
      setTimeout(() => URL.revokeObjectURL(uri), 30_000);
    }
  },
};

export function createNativeMobileArchivePorts(
  options: Omit<MobileArchiveOptions, "files" | "zip" | "pdf">,
): MobileArchivePorts {
  return createMobileArchivePorts({
    ...options,
    files: nativeArchiveFiles,
    zip: mobileArchiveZip,
    pdf: browserArchivePdf,
  });
}
