import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";

export interface ChatSearchSource {
  conversationId: string;
  messageId: string;
  /** A base message uses messageId; a selected response uses its variant ID. */
  variantId: string;
}

export interface ChatSearchResult {
  conversationId: string;
  title: string;
  text: string;
  role: "title" | "user" | "assistant";
  source?: ChatSearchSource;
  sequence?: number;
  mode: "local" | "semantic" | "fts";
  score?: number;
}

/** Compatible with SQLiteSemanticSearch; the caller owns its runtime/index. */
export interface ChatSemanticQueryPort {
  search(
    query: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<readonly ChatSemanticCandidate[]>;
}

export interface ChatSemanticCandidate extends ChatSearchSource {
  text: string;
  active: boolean;
  score: number;
  mode: "semantic" | "fts";
}

interface SourceRow {
  conversation_id: string;
  title: string | null;
  message_id: string;
  variant_id: string;
  role: "user" | "assistant";
  sequence: number;
  parts_json: string;
}

const SOURCE_SELECT = `SELECT c.id AS conversation_id,c.title,m.id AS message_id,
  COALESCE(v.id,m.id) AS variant_id,m.role,m.sequence,
  COALESCE(v.content_json,m.parts_json) AS parts_json
  FROM messages m JOIN conversations c ON c.id=m.conversation_id
  LEFT JOIN response_variants v ON v.message_id=m.id AND v.selected=1`;

/** Search visible saved text without indexing reasoning, tools or secrets. */
export async function searchLocalChat(
  db: SQLiteDatabasePort,
  query: string,
  options: {
    conversationId?: string;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ChatSearchResult[]> {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];
  const limit = checkedLimit(options.limit ?? 30);
  const conversationId = options.conversationId ?? null;
  const results: ChatSearchResult[] = [];
  // Page the database so long libraries do not allocate all message bodies.
  const pageSize = 128;
  for (let offset = 0; results.length < limit; offset += pageSize) {
    checkCanceled(options.signal);
    const rows = await db.getAllAsync<{ id: string; title: string | null }>(
      `SELECT id,title FROM conversations WHERE (? IS NULL OR id=?)
       ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
      conversationId,
      conversationId,
      pageSize,
      offset,
    );
    for (const row of rows) {
      if (row.title?.toLocaleLowerCase().includes(normalized)) {
        results.push({
          conversationId: row.id,
          title: displayTitle(row.title),
          text: row.title,
          role: "title",
          mode: "local",
        });
        if (results.length === limit) break;
      }
    }
    if (rows.length < pageSize) break;
  }
  for (let offset = 0; results.length < limit; offset += pageSize) {
    checkCanceled(options.signal);
    const rows = await db.getAllAsync<SourceRow>(
      `${SOURCE_SELECT}
       WHERE m.role IN ('user','assistant') AND (? IS NULL OR c.id=?)
       ORDER BY c.updated_at DESC,c.id,m.sequence LIMIT ? OFFSET ?`,
      conversationId,
      conversationId,
      pageSize,
      offset,
    );
    for (const row of rows) {
      const text = visibleSearchText(row.parts_json);
      if (text.toLocaleLowerCase().includes(normalized)) {
        results.push(fromSource(row, text, "local"));
        if (results.length === limit) break;
      }
    }
    if (rows.length < pageSize) break;
  }
  checkCanceled(options.signal);
  return results;
}

/** Reject deleted messages, foreign conversations and superseded variants. */
export async function resolveSearchSource(
  db: SQLiteDatabasePort,
  source: ChatSearchSource,
  expectedText?: string,
): Promise<ChatSearchResult | null> {
  const row = await db.getFirstAsync<SourceRow>(
    `${SOURCE_SELECT} WHERE c.id=? AND m.id=? AND m.role IN ('user','assistant')`,
    source.conversationId,
    source.messageId,
  );
  if (!row || row.variant_id !== source.variantId) return null;
  const text = visibleSearchText(row.parts_json);
  if (!text || (expectedText !== undefined && text !== expectedText))
    return null;
  return fromSource(row, text, "local");
}

/** Resolve index references against current storage before presenting results. */
export async function searchSemanticChat(
  db: SQLiteDatabasePort,
  port: ChatSemanticQueryPort,
  query: string,
  options: {
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ChatSearchResult[]> {
  if (!normalizeQuery(query)) return [];
  const limit = checkedLimit(options.limit ?? 30);
  checkCanceled(options.signal);
  const candidates = await port.search(query.trim(), limit, options.signal);
  const results: ChatSearchResult[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates.slice(0, limit)) {
    checkCanceled(options.signal);
    if (!candidate.active || !Number.isFinite(candidate.score)) continue;
    const key = `${candidate.messageId}\u001f${candidate.variantId}`;
    if (seen.has(key)) continue;
    const resolved = await resolveSearchSource(db, candidate, candidate.text);
    if (resolved) {
      seen.add(key);
      results.push({
        ...resolved,
        mode: candidate.mode,
        score: candidate.score,
      });
    }
  }
  checkCanceled(options.signal);
  return results;
}

export function searchResultSnippet(text: string, query: string): string {
  const normalized = query.trim().toLocaleLowerCase();
  const index = normalized ? text.toLocaleLowerCase().indexOf(normalized) : -1;
  const start = Math.max(0, index - 55);
  const end = Math.min(text.length, start + 220);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Only ordinary displayed text parts enter local or semantic search. */
export function visibleSearchText(partsJson: string): string {
  let parts: unknown;
  try {
    parts = JSON.parse(partsJson) as unknown;
  } catch {
    return "";
  }
  if (!Array.isArray(parts)) return "";
  return parts
    .flatMap((part: unknown) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      return (value.type === "text" || value.kind === "text") &&
        typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join("");
}

function fromSource(
  row: SourceRow,
  text: string,
  mode: ChatSearchResult["mode"],
): ChatSearchResult {
  return {
    conversationId: row.conversation_id,
    title: displayTitle(row.title),
    text,
    role: row.role,
    source: {
      conversationId: row.conversation_id,
      messageId: row.message_id,
      variantId: row.variant_id,
    },
    sequence: row.sequence,
    mode,
  };
}

function displayTitle(title: string | null): string {
  return title?.trim() || "New conversation";
}

function normalizeQuery(query: string): string {
  if (query.length > 500)
    throw new RangeError("Search must be 500 characters or fewer.");
  return query.trim().toLocaleLowerCase();
}

function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("Search limit must be between 1 and 100.");
  return limit;
}

function checkCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Search canceled.");
}
