export interface ArchiveAsset {
  path: string;
  mimeType: string;
  bytes: Uint8Array;
}
export interface ArchiveMessage {
  id: string;
  role: string;
  parts: readonly unknown[];
  variants?: readonly {
    id: string;
    parts: readonly unknown[];
    selected?: boolean;
  }[];
}
export interface ArchiveConversation {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  messages: readonly ArchiveMessage[];
}
export interface ArchiveSnapshot {
  schema: "locallab-chat-archive";
  version: 1;
  exportedAt: string;
  conversations: readonly ArchiveConversation[];
  assets: readonly { path: string; mimeType: string; sha256?: string }[];
}
export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}
export interface ZipPort {
  encode(entries: readonly ZipEntry[]): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<readonly ZipEntry[]>;
}
export class ArchiveValidationError extends Error {
  name = "ArchiveValidationError";
}
export class UnsupportedLMStudioVersionError extends Error {
  name = "UnsupportedLMStudioVersionError";
  constructor(readonly version: unknown) {
    super(
      `Unsupported LM Studio conversation export version: ${String(version ?? "missing")}`,
    );
  }
}

const MAX_ENTRIES = 20_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export function validateArchiveEntries(entries: readonly ZipEntry[]): void {
  if (entries.length > MAX_ENTRIES)
    throw new ArchiveValidationError("Archive contains too many entries");
  let total = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = entry.path.replaceAll("\\", "/");
    if (
      !path ||
      path.startsWith("/") ||
      /^[a-zA-Z]:/.test(path) ||
      path.split("/").some((part) => part === ".." || part === ".")
    )
      throw new ArchiveValidationError(`Unsafe archive path: ${entry.path}`);
    if (seen.has(path))
      throw new ArchiveValidationError(`Duplicate archive path: ${path}`);
    seen.add(path);
    total += entry.bytes.byteLength;
    if (total > MAX_ARCHIVE_BYTES)
      throw new ArchiveValidationError(
        "Archive exceeds the 512 MiB uncompressed limit",
      );
  }
}

/** LM Studio v1 interchange shape is deliberately explicit; unknown exports fail without partial import. */
export function importLMStudioExport(input: unknown): ArchiveConversation[] {
  if (!isRecord(input))
    throw new ArchiveValidationError("LM Studio export must be a JSON object");
  const version = input.version ?? input.schemaVersion;
  if (version !== 1) throw new UnsupportedLMStudioVersionError(version);
  if (!Array.isArray(input.conversations))
    throw new ArchiveValidationError(
      "LM Studio export is missing conversations",
    );
  return input.conversations.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !Array.isArray(item.messages)
    )
      throw new ArchiveValidationError(
        `Invalid LM Studio conversation at index ${index}`,
      );
    const messages = item.messages.map(
      (message, messageIndex): ArchiveMessage => {
        if (!isRecord(message) || typeof message.role !== "string")
          throw new ArchiveValidationError(
            `Invalid message ${messageIndex} in conversation ${item.id}`,
          );
        const content = message.content;
        const parts = Array.isArray(content)
          ? content
          : [
              {
                type: "text",
                text: typeof content === "string" ? content : "",
              },
            ];
        return {
          id:
            typeof message.id === "string"
              ? message.id
              : `${item.id}:${messageIndex}`,
          role: message.role,
          parts,
        };
      },
    );
    return {
      id: item.id,
      title:
        typeof item.title === "string" ? item.title : "Imported conversation",
      messages,
    };
  });
}

export function exportConversationTxt(
  conversation: ArchiveConversation,
): Uint8Array {
  const lines = [`# ${conversation.title}`, ""];
  for (const message of conversation.messages) {
    lines.push(`## ${message.role}`, textOf(message.parts));
    for (const [i, variant] of (message.variants ?? []).entries())
      lines.push(
        `### Variant ${i + 1}${variant.selected ? " (selected)" : ""}`,
        textOf(variant.parts),
      );
    lines.push("");
  }
  return new TextEncoder().encode(lines.join("\n"));
}

/** A minimal standards-compliant PDF text document; attachment bytes remain in ZIP assets. */
export function exportConversationPdf(
  conversation: ArchiveConversation,
): Uint8Array {
  const lines = [
    `${conversation.title}`,
    ...conversation.messages.flatMap((m) => [
      `${m.role}: ${textOf(m.parts)}`,
      ...(m.variants ?? []).map(
        (v, i) => `Variant ${i + 1}: ${textOf(v.parts)}`,
      ),
    ]),
  ];
  const escaped = lines
    .map((line) =>
      line
        .replace(/[^\x20-\x7E]/g, "?")
        .replaceAll("\\", "\\\\")
        .replaceAll("(", "\\(")
        .replaceAll(")", "\\)"),
    )
    .join("\n");
  const stream = `BT /F1 10 Tf 50 780 Td 12 TL (${escaped.replaceAll("\n", ") Tj T* (")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

export async function exportAllChatsZip(
  conversations: readonly ArchiveConversation[],
  assets: readonly ArchiveAsset[],
  zip: ZipPort,
  exportedAt = new Date().toISOString(),
): Promise<Uint8Array> {
  const safeAssets = assets.map((a) => ({
    ...a,
    path: `assets/${safeAssetPath(a.path)}`,
  }));
  const cleanConversations = conversations.map(sanitizeConversation);
  const manifest: ArchiveSnapshot = {
    schema: "locallab-chat-archive",
    version: 1,
    exportedAt,
    conversations: cleanConversations,
    assets: safeAssets.map(({ path, mimeType }) => ({ path, mimeType })),
  };
  const entries: ZipEntry[] = [
    {
      path: "manifest.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    },
    ...cleanConversations.map((c) => ({
      path: `chats/${safeAssetPath(c.id)}.json`,
      bytes: new TextEncoder().encode(JSON.stringify(c)),
    })),
    ...safeAssets.map(({ path, bytes }) => ({ path, bytes })),
  ];
  validateArchiveEntries(entries);
  return zip.encode(entries);
}

export async function importAllChatsZip(
  bytes: Uint8Array,
  zip: ZipPort,
): Promise<{
  manifest: ArchiveSnapshot;
  conversations: ArchiveConversation[];
  assets: ArchiveAsset[];
}> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new ArchiveValidationError("Archive exceeds the 512 MiB limit");
  let entries: readonly ZipEntry[];
  try {
    entries = await zip.decode(bytes);
  } catch {
    throw new ArchiveValidationError("ZIP is malformed or unreadable");
  }
  validateArchiveEntries(entries);
  const byPath = new Map(
    entries.map((entry) => [entry.path.replaceAll("\\", "/"), entry]),
  );
  const manifestEntry = byPath.get("manifest.json");
  if (!manifestEntry)
    throw new ArchiveValidationError("Archive is missing manifest.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
  } catch {
    throw new ArchiveValidationError("Archive manifest is malformed JSON");
  }
  if (
    !isRecord(manifest) ||
    manifest.schema !== "locallab-chat-archive" ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.conversations) ||
    !Array.isArray(manifest.assets)
  )
    throw new ArchiveValidationError(
      "Unsupported or malformed chat archive manifest",
    );
  const conversations = manifest.conversations as ArchiveConversation[];
  const assets: ArchiveAsset[] = [];
  for (const item of manifest.assets) {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.mimeType !== "string"
    )
      throw new ArchiveValidationError("Invalid asset declaration");
    const entry = byPath.get(item.path);
    if (!entry)
      throw new ArchiveValidationError(
        `Archive is missing required asset: ${item.path}`,
      );
    assets.push({
      path: item.path,
      mimeType: item.mimeType,
      bytes: entry.bytes,
    });
  }
  return {
    manifest: manifest as unknown as ArchiveSnapshot,
    conversations,
    assets,
  };
}

function safeAssetPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === ".") ||
    /^[a-zA-Z]:/.test(normalized)
  )
    throw new ArchiveValidationError(`Unsafe archive path: ${path}`);
  return normalized;
}
function textOf(parts: readonly unknown[]): string {
  return parts
    .map((part) =>
      isRecord(part) && typeof part.text === "string"
        ? part.text
        : isRecord(part) && typeof part.type === "string"
          ? `[${part.type}]`
          : "",
    )
    .join("");
}
function sanitizeConversation(value: ArchiveConversation): ArchiveConversation {
  return sanitize(value) as ArchiveConversation;
}
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      /(?:api.?key|access.?token|refresh.?token|credential|authorization|password|secret|pin|private.?key)/i.test(
        key,
      )
    )
      continue;
    result[key] = sanitize(item);
  }
  return result;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
