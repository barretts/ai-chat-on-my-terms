import type {
  ConversationFolder,
  ConversationLibraryPort,
  LibraryConversation,
} from "@locallab/conversation-library";

export type {
  ConversationFolder,
  ConversationLibraryPort,
  LibraryConversation,
};

export interface LibraryFeatureProps {
  readonly library: ConversationLibraryPort & {
    createFolder(input: {
      id: string;
      name: string;
      now: string;
      color?: string;
      coverBlobId?: string | null;
    }): Promise<ConversationFolder>;
    updateFolder(
      id: string,
      input: {
        name?: string;
        color?: string;
        coverBlobId?: string | null;
        now: string;
      },
    ): Promise<ConversationFolder>;
    deleteFolder(id: string, now: string): Promise<void>;
    moveConversation(
      conversationId: string,
      folderId: string | null,
    ): Promise<void>;
  };
  readonly onOpenConversation: (conversationId: string) => void;
  readonly onSelectCover?: (
    folder: ConversationFolder,
  ) => Promise<string | null>;
  readonly createId: () => string;
  readonly now?: () => string;
}

export function conversationDisplayTitle(
  conversation: LibraryConversation,
): string {
  return conversation.title?.trim() || "New conversation";
}
