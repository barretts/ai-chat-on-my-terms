import type { SQLiteDatabasePort } from "@locallab/storage-sqlite-core";
import { initializeChatHistory } from "@locallab/chat-history";
import {
  initializeConversationLibrary,
  SQLiteConversationLibrary,
} from "@locallab/conversation-library";
import { SQLiteChatSettingsStore } from "./settings-store";
import {
  ChatIntegration,
  type ChatFeatureBindings,
} from "@locallab/chat-integration";
import type {
  AdvancedChatEngine,
  AdvancedChatRunHandle,
  AdvancedSendInput,
} from "@locallab/chat-engine-advanced";
export {
  initializePersonaMemoryChat,
  personaMemoryPolicy,
  personaSystemPrompt,
} from "./persona-memory";
import { SQLiteGroupConfigStore } from "@locallab/groups-config";

/** Initializes additive chat features after the app core schema exists. */
export async function initializeMobileChatComposition(db: SQLiteDatabasePort) {
  await initializeChatHistory(db);
  await initializeConversationLibrary(db);
  await SQLiteChatSettingsStore.initialize(db);
  await SQLiteGroupConfigStore.initialize(db);
  return {
    library: new SQLiteConversationLibrary(db),
    settingsForConversation: (conversationId: string) =>
      new SQLiteChatSettingsStore(db, conversationId),
  } as const;
}

export { SQLiteChatSettingsStore } from "./settings-store";

export function createMobileChatIntegration(
  engine: Pick<AdvancedChatEngine, "send">,
  features: ChatFeatureBindings,
) {
  return new ChatIntegration<AdvancedSendInput, AdvancedChatRunHandle>(
    (input) => engine.send(input),
    features,
  );
}
