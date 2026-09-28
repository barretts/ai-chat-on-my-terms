import {
  importLMStudioExport,
  type ArchiveConversation,
} from "@locallab/archives";

export interface ArchiveFeaturePorts {
  readPickedJson(): Promise<string | undefined>;
  saveImported(conversations: readonly ArchiveConversation[]): Promise<void>;
  exportSelected(kind: "txt" | "pdf"): Promise<void>;
  exportAll(): Promise<void>;
  importAll?(): Promise<number>;
}

/** Picker and share integrations are explicit ports, allowing platforms to supply native implementations. */
export async function importLMStudioFile(
  ports: ArchiveFeaturePorts,
): Promise<number> {
  const json = await ports.readPickedJson();
  if (json === undefined) return 0;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Selected LM Studio export is not valid JSON");
  }
  const conversations = importLMStudioExport(value);
  await ports.saveImported(conversations);
  return conversations.length;
}
