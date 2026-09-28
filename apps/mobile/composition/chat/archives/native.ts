import type { ArchiveConversation } from "@locallab/archives";
import { createMobileArchivePorts } from "./index";
import { mobileArchiveZip } from "./zip";
import type {
  ArchiveFilePort,
  ArchivePdfPort,
  MobileArchiveOptions,
  MobileArchivePorts,
} from "./types";

/** Native modules load only when an archive action runs, and report missing modules as errors. */
export const nativeArchiveFiles: ArchiveFilePort = {
  async pick(kind, maxBytes) {
    const [picker, fs] = await Promise.all([
      import("expo-document-picker"),
      import("expo-file-system"),
    ]);
    const result = await picker.getDocumentAsync({
      type:
        kind === "json"
          ? ["application/json", "text/json", "text/plain"]
          : ["application/zip", "application/x-zip-compressed"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return undefined;
    const asset = result.assets[0];
    if (!asset) return undefined;
    if (asset.size !== undefined && asset.size > maxBytes)
      throw new Error("Selected archive exceeds the supported size limit");
    const file = new fs.File(asset.uri);
    if (file.size > maxBytes)
      throw new Error("Selected archive exceeds the supported size limit");
    const bytes = await file.bytes();
    if (bytes.byteLength > maxBytes)
      throw new Error("Selected archive exceeds the supported size limit");
    return bytes;
  },
  async share({ name, mimeType, bytes }) {
    const [sharing, fs] = await Promise.all([
      import("expo-sharing"),
      import("expo-file-system"),
    ]);
    if (!(await sharing.isAvailableAsync()))
      throw new Error("File sharing is unavailable on this device");
    if (!/^[A-Za-z0-9_.-]{1,255}$/.test(name) || name === "." || name === "..")
      throw new Error("Export filename is invalid");
    const directory = new fs.Directory(fs.Paths.cache, "locallab-chat-exports");
    directory.create({ intermediates: true, idempotent: true });
    const file = new fs.File(directory, name);
    file.create({ overwrite: true });
    file.write(bytes);
    try {
      await sharing.shareAsync(file.uri, {
        mimeType,
        dialogTitle: "Export chat",
        ...(mimeType === "application/pdf"
          ? { UTI: "com.adobe.pdf" }
          : mimeType === "application/zip"
            ? { UTI: "public.zip-archive" }
            : { UTI: "public.plain-text" }),
      });
    } finally {
      if (file.exists) file.delete();
    }
  },
};

/** The native print engine supplies Unicode fonts and page layout for long conversations. */
export const nativeArchivePdf: ArchivePdfPort = {
  async render(conversation) {
    const [printing, fs] = await Promise.all([
      import("expo-print"),
      import("expo-file-system"),
    ]);
    const result = await printing.printToFileAsync({
      html: conversationPdfHtml(conversation),
    });
    const file = new fs.File(result.uri);
    try {
      return await file.bytes();
    } finally {
      if (file.exists) file.delete();
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
    pdf: nativeArchivePdf,
  });
}

export function conversationPdfHtml(conversation: ArchiveConversation): string {
  const text = (parts: readonly unknown[]) =>
    parts
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const item = part as { text?: unknown; type?: unknown };
        return typeof item.text === "string"
          ? item.text
          : typeof item.type === "string"
            ? `[${item.type}]`
            : "";
      })
      .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 36px; } body { font-family: -apple-system, sans-serif; font-size: 11pt; color: #181818; }
    h1 { font-size: 18pt; } h2 { font-size: 12pt; break-after: avoid; } h3 { font-size: 11pt; break-after: avoid; }
    pre { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; } article { margin-bottom: 20px; }
    </style></head><body><h1>${escapeHtml(conversation.title)}</h1>${conversation.messages
      .map(
        (message) =>
          `<article><h2>${escapeHtml(message.role)}</h2><pre>${escapeHtml(text(message.parts))}</pre>${(
            message.variants ?? []
          )
            .map(
              (variant, index) =>
                `<h3>Variant ${index + 1}${variant.selected ? " (selected)" : ""}</h3><pre>${escapeHtml(text(variant.parts))}</pre>`,
            )
            .join("")}</article>`,
      )
      .join("")}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
