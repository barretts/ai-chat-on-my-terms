import type {
  MediaJobService,
  MediaRequestOutcome,
} from "@locallab/media-engine";
import {
  resolvePersonaMediaBinding,
  type PersonaWorkflowRegistration,
} from "@locallab/personas-media";

/** A chat turn as it ends; text and media run on separate lifecycles. */
export interface ChatMediaTurn {
  conversationId: string;
  /** Final assistant text for this turn; never written back to history. */
  assistantText: string;
  /** Only a completed text turn may launch automatic image work. */
  finalState: "completed" | "canceled" | "failed";
  /** Persona profile attached to the turn, if any. */
  personaProfile?: unknown;
}

export interface ChatMediaHookContext {
  service: MediaJobService;
  /** Global media workflow used only when the Persona pins none. */
  defaultWorkflow?: PersonaWorkflowRegistration;
  findWorkflow: (
    workflowId: string,
  ) => PersonaWorkflowRegistration | undefined | Promise<
    PersonaWorkflowRegistration | undefined
  >;
}

export type ChatMediaHookResult =
  | MediaRequestOutcome
  | { kind: "skipped"; reason: string };

/** Derive an image prompt from the reply without touching chat titles/history. */
export function imagePromptFrom(turn: ChatMediaTurn): string {
  const firstLine = turn.assistantText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")[0];
  if (!firstLine) return "";
  return firstLine.length > 300 ? `${firstLine.slice(0, 297)}…` : firstLine;
}

/**
 * Fires when a text turn ends. Stopping text before completion never reaches
 * the image engine (cancel semantics preserved). A Persona-bound workflow
 * wins over the global setting; a removed binding skips with an explanation
 * instead of silently using the global workflow. The engine still applies
 * settings (auto-generate toggle, prompt review) to whatever is submitted.
 */
export async function onChatTurnCompleted(
  turn: ChatMediaTurn,
  context: ChatMediaHookContext,
): Promise<ChatMediaHookResult> {
  if (turn.finalState !== "completed")
    return {
      kind: "skipped",
      reason: "The reply did not complete, so no image work was started.",
    };
  const resolution =
    turn.personaProfile === undefined
      ? { status: "unbound" as const }
      : await resolvePersonaMediaBinding(turn.personaProfile, context.findWorkflow);
  if (resolution.status === "missing")
    return { kind: "skipped", reason: resolution.message ?? "Workflow missing." };
  const workflow = resolution.workflow ?? context.defaultWorkflow;
  if (!workflow)
    return {
      kind: "skipped",
      reason: "No image workflow is selected in Settings.",
    };
  const prompt = imagePromptFrom(turn);
  if (prompt === "")
    return {
      kind: "skipped",
      reason: "The reply had no usable prompt text.",
    };
  return context.service.requestGeneration({
    conversationId: turn.conversationId,
    prompt,
    requestedBy: "chat",
    workflow,
  });
}
