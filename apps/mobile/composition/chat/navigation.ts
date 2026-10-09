export const chatPageLabels = {
  providers: "Connections",
  voices: "Voices",
  library: "Library",
  files: "Files",
  settings: "Settings",
  search: "Search chats",
  archives: "Import & export",
  personas: "Personas",
  memory: "Memory",
  history: "Recent chats",
  research: "Web research",
  diagnostics: "Trace log",
} as const;

export type ChatPage = keyof typeof chatPageLabels;
export function readChatPage(
  value: string | string[] | undefined,
): ChatPage | null {
  const name = Array.isArray(value) ? value[0] : value;
  if (name === "connections") return "providers";
  if (name === "import-export") return "archives";
  return name && Object.hasOwn(chatPageLabels, name)
    ? (name as ChatPage)
    : null;
}
export function chatPageParam(page: ChatPage | null): string {
  return page === "providers"
    ? "connections"
    : page === "archives"
      ? "import-export"
      : (page ?? "");
}
