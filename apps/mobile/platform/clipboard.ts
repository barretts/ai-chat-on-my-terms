import { setStringAsync } from "expo-clipboard";

/** Preserve the original Markdown, including fences and intentional whitespace. */
export async function writeClipboardMarkdown(markdown: string): Promise<void> {
  if ((await setStringAsync(markdown)) === false)
    throw new Error("The clipboard could not be updated. Try copying again.");
}
