/** Invoke the browser write directly during the Copy click to retain user activation. */
export async function writeClipboardMarkdown(markdown: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText)
    throw new Error(
      "Clipboard access is unavailable. Open this page on localhost or HTTPS and try Copy again.",
    );
  try {
    await clipboard.writeText(markdown);
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "SecurityError")
    )
      throw new Error(
        "Clipboard access was denied. Allow clipboard permission and try Copy again.",
        { cause: error },
      );
    throw new Error("The clipboard could not be updated. Try copying again.", {
      cause: error,
    });
  }
}
