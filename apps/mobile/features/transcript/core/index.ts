export interface UserTranscriptMessage {
  id: string;
  role: "user";
  text: string;
  order?: number;
}

export type AssistantTranscriptPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; invocationId: string; name: string; input: unknown }
  | { type: "tool-result"; invocationId: string; output: unknown }
  | { type: "source"; url: string; title?: string }
  | { type: "media"; mediaId: string; mediaType: string };

export interface AssistantTranscriptMessage {
  id: string;
  role: "assistant";
  runId: string;
  /** Conversation position assigned by the transcript coordinator. */
  order?: number;
  status: "idle" | "running" | "completed" | "canceled" | "failed";
  finishReason?: string;
  parts: AssistantTranscriptPart[];
  error?: { code: string; message: string; recoverable: boolean };
}

export type TranscriptRow = UserTranscriptMessage | AssistantTranscriptMessage;

export function assistantStatusLabel(
  message: AssistantTranscriptMessage,
): string | undefined {
  switch (message.status) {
    case "running":
      return "Generating response";
    case "completed":
      return message.finishReason === "length" ||
        message.finishReason === "max_tokens"
        ? "Output limit reached. Increase maximum output tokens in Settings and retry."
        : "Response complete";
    case "canceled":
      return "Response stopped";
    case "failed":
      return message.error?.message ?? "Response failed";
    default:
      return undefined;
  }
}

/** Stable message keys let FlatList update streamed assistant content in place. */
export function mergeTranscriptRows(
  users: readonly UserTranscriptMessage[],
  assistants: readonly AssistantTranscriptMessage[],
): TranscriptRow[] {
  return [...users, ...assistants]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.order !== undefined && b.row.order !== undefined) {
        return a.row.order - b.row.order || a.row.id.localeCompare(b.row.id);
      }
      if (a.row.order !== undefined) return -1;
      if (b.row.order !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

export function assistantPlainText(
  message: AssistantTranscriptMessage,
): string {
  return message.parts
    .filter(
      (part): part is Extract<AssistantTranscriptPart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}
