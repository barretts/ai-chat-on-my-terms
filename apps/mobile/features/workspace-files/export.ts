import { strToU8 } from "fflate";
import type { ZipPort } from "@locallab/archives";
import type { ArchiveFilePort } from "../../composition/chat/archives/types";
import { WorkspaceFileError, type WorkspaceFilesStore } from "./store";

export async function exportWorkspaceFile(
  store: WorkspaceFilesStore,
  path: string,
  files: Pick<ArchiveFilePort, "share">,
): Promise<void> {
  const file = await store.read(path);
  if (!file)
    throw new WorkspaceFileError(
      "missing-file",
      "This file is no longer available. Reload Files before exporting.",
    );
  await files.share({
    name: file.path.split("/").at(-1)!,
    mimeType: file.kind === "markdown" ? "text/markdown" : "text/plain",
    bytes: strToU8(file.content),
  });
}

export async function exportWorkspaceZip(
  store: WorkspaceFilesStore,
  files: Pick<ArchiveFilePort, "share">,
  zip: Pick<ZipPort, "encode">,
): Promise<void> {
  const snapshot = await store.snapshot();
  if (!snapshot.length)
    throw new WorkspaceFileError(
      "missing-file",
      "There are no files in this chat to export. Create a file first.",
    );
  const bytes = await zip.encode(
    snapshot.map((file) => ({ path: file.path, bytes: strToU8(file.content) })),
  );
  await files.share({
    name: "locallab-workspace.zip",
    mimeType: "application/zip",
    bytes,
  });
}
