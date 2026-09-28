import type {
  ConversationHistoryPort,
  HistoryConversation,
} from "@locallab/conversation-library";

export type { ConversationHistoryPort, HistoryConversation };

export type HistoryView = "recent" | "archived";

export interface HistoryFeatureProps {
  readonly history: ConversationHistoryPort;
  readonly currentConversationId: string;
  /** True while a reply is streaming in the current conversation. */
  readonly working?: boolean;
  readonly onOpenConversation: (conversationId: string) => void;
  /** The chat screen owns deletion so it can stop a stream and replace the open chat. */
  readonly onDeleteConversation: (conversationId: string) => Promise<void>;
  readonly onClose: () => void;
  readonly onOpenLibrary?: () => void;
  readonly now?: () => Date;
}

export function historyDisplayTitle(conversation: {
  title: string | null;
}): string {
  return conversation.title?.trim() || "New chat";
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Short, scannable list date in the device's local time: "9:05 AM", "Yesterday", "Mon", "Sep 27", "Sep 27, 2025". */
export function formatHistoryDate(iso: string | null | undefined, now: Date): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) {
    const hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, "0");
    return `${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAYS[date.getDay()] ?? "";
  const monthDay = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear()
    ? monthDay
    : `${monthDay}, ${date.getFullYear()}`;
}

export function historyRowDate(conversation: HistoryConversation): string | null {
  return conversation.lastUsedAt ?? conversation.updatedAt ?? conversation.createdAt;
}

/** One sentence VoiceOver reads for a history row. */
export function historyRowLabel(
  conversation: HistoryConversation,
  options: { current: boolean; now: Date },
): string {
  const date = formatHistoryDate(historyRowDate(conversation), options.now);
  return [
    historyDisplayTitle(conversation),
    options.current ? "open now" : null,
    date || null,
    conversation.preview ?? "no messages yet",
  ]
    .filter(Boolean)
    .join(", ");
}

export function deleteConfirmationText(input: {
  title: string;
  current: boolean;
  working: boolean;
}): string {
  return [
    `Delete "${input.title}" for good? Its messages and attachments will be removed from this phone.`,
    "Saved memories stay in Memory.",
    input.current
      ? input.working
        ? "The reply being written will stop, and a new empty chat will take its place."
        : "A new empty chat will take its place."
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Which row, if any, is showing its actions or the delete confirmation. */
export type HistoryRowState =
  | { readonly kind: "idle" }
  | { readonly kind: "actions"; readonly id: string }
  | { readonly kind: "confirm-delete"; readonly id: string };

export type HistoryRowEvent =
  | { readonly type: "toggle-actions"; readonly id: string }
  | { readonly type: "request-delete"; readonly id: string }
  | { readonly type: "dismiss" };

export const IDLE_ROW: HistoryRowState = { kind: "idle" };

export function historyRowReducer(
  state: HistoryRowState,
  event: HistoryRowEvent,
): HistoryRowState {
  switch (event.type) {
    case "toggle-actions":
      return state.kind !== "idle" && state.id === event.id
        ? IDLE_ROW
        : { kind: "actions", id: event.id };
    case "request-delete":
      return { kind: "confirm-delete", id: event.id };
    case "dismiss":
      return IDLE_ROW;
  }
}

/**
 * What "New chat" should do right now. Never silently ignore the tap: a streaming reply
 * asks first, and an already-empty chat just says so instead of stacking blank chats.
 */
export type NewChatPlan = "confirm-stop" | "already-new" | "create";

export function planNewChat(input: {
  working: boolean;
  messageCount: number;
}): NewChatPlan {
  if (input.working) return "confirm-stop";
  if (input.messageCount === 0) return "already-new";
  return "create";
}

/** Unsent drafts kept per conversation for this app session. */
export class DraftShelf {
  private readonly drafts = new Map<string, string>();

  put(conversationId: string, text: string): void {
    if (text.trim()) this.drafts.set(conversationId, text);
    else this.drafts.delete(conversationId);
  }

  get(conversationId: string): string {
    return this.drafts.get(conversationId) ?? "";
  }

  has(conversationId: string): boolean {
    return this.drafts.has(conversationId);
  }

  forget(conversationId: string): void {
    this.drafts.delete(conversationId);
  }
}
