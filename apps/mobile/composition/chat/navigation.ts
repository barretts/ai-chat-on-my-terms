export const chatPageLabels = {
  providers: "Connections",
  voice: "Voice settings",
  voices: "Voices",
  library: "Library",
  files: "Files",
  settings: "Settings",
  search: "Search chats",
  archives: "Import & export",
  personas: "Personas",
  groups: "Group chats",
  media: "Image generation",
  memory: "Memory",
  history: "Recent chats",
  research: "Web research",
  diagnostics: "Trace log",
  tools: "Tools",
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
