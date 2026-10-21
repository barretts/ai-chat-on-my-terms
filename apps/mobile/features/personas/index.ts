import type {
  PersonaAppearance,
  PersonaChatIntent,
  PersonaGroupIntent,
  PersonaLibraryPort,
  PersonaRecord,
  PersonaSwitchIntent,
} from "@locallab/personas-library";
import type { PersonaModelConnectionOption } from "../persona-bindings";
import type { PersonaGenerateHandler } from "../persona-generator";

export interface PersonaAvatar {
  attachmentId: string;
  uri: string;
}

/** Pickers copy images into managed storage before returning an avatar reference. */
export interface PersonaAvatarPort {
  pick(
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<PersonaAvatar | undefined>;
  resolve(attachmentId: string): Promise<string | undefined>;
  release(attachmentId: string, ownerId: string): Promise<void>;
}

export interface PersonaFeatureProps {
  library: PersonaLibraryPort;
  createId: () => string;
  avatarPort?: PersonaAvatarPort;
  currentConversationId?: string;
  currentGroupRoomId?: string;
  groupUnavailableReason?: string;
  onLaunchChat: (intent: PersonaChatIntent) => Promise<void> | void;
  onAddToGroup: (intent: PersonaGroupIntent) => Promise<void> | void;
  onSwitch?: (intent: PersonaSwitchIntent) => Promise<void> | void;
  /** Refreshes the host's selected profile after a durable profile mutation. */
  onProfilesChanged?: () => Promise<void> | void;
  onClose?: () => void;
  /** Optional AI Persona Generator (PE-06); results are review-only drafts. */
  generatePersona?: PersonaGenerateHandler;
  /** Global memory switches shown as defaults in the Persona editor. */
  globalMemorySettings?: { extract: boolean; inject: boolean };
  /** Persists the Persona sharing switch to the memory scope store. */
  onPersonaMemoryPolicy?: (
    personaId: string,
    share: boolean,
  ) => Promise<void> | void;
  /** Saved provider connections offered as Persona model bindings (PE-02). */
  modelConnections?: readonly PersonaModelConnectionOption[];
  /** Reload the shipped starter trope pack (T184): re-insert deleted or
   * lost characters, clear their tombstones, and keep user edits intact. */
  loadStarterPack?: () => Promise<void>;
}

export interface PersonaEditorDraft {
  profile?: Readonly<Record<string, unknown>>;
  name: string;
  description: string;
  prompt: string;
  photoAttachmentId: string | null;
  appearance: PersonaAppearance;
}

export function personaEditorDraft(persona: PersonaRecord): PersonaEditorDraft {
  return {
    profile: persona.profile,
    name: persona.name,
    description: persona.description,
    prompt: persona.prompt,
    photoAttachmentId: persona.photoAttachmentId,
    appearance: { ...persona.appearance },
  };
}

export function personaInitials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toLocaleUpperCase() || "P"
  );
}

export type {
  PersonaAppearance,
  PersonaChatIntent,
  PersonaGroupIntent,
  PersonaLibraryPort,
  PersonaRecord,
  PersonaSwitchIntent,
};
