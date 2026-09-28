/** The app binds this intent to ChatEngine.send and consumes its run events. */
export type ComposerSendIntent = (text: string) => Promise<unknown>;

export function normalizeComposerDraft(draft: string): string {
  return draft.trim();
}

/**
 * Send a non-empty draft and report acceptance. Rejections intentionally pass
 * through so the UI can keep the user's draft and present its own error.
 */
export async function submitComposerDraft(
  draft: string,
  send: ComposerSendIntent,
): Promise<boolean> {
  const text = normalizeComposerDraft(draft);
  if (!text) return false;
  await send(text);
  return true;
}
