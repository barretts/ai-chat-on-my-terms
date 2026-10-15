import type { JobRecord } from "@locallab/jobs";
import {
  IMAGE_GENERATE_KIND,
  MediaSnapshotSchema,
  type MediaRequestOutcome,
  type MediaReviewDraft,
} from "@locallab/media-engine";
import { recognizeArtifact, type MediaArtifact } from "@locallab/media-video";
import { TypedErrorSchema } from "@locallab/contracts/entities";


function stringRefs(result: unknown): string[] {
  if (!result || typeof result !== "object" || !("outputRefs" in result))
    return [];
  const refs = result.outputRefs;
  return Array.isArray(refs)
    ? refs.filter((ref): ref is string => typeof ref === "string")
    : [];
}

/** Typed error stored by the engine as JSON; raw strings survive untouched. */
export function errorText(serialized: string): string {
  try {
    const parsed = TypedErrorSchema.safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data.message : serialized;
  } catch {
    return serialized;
  }
}

export interface MediaJobView {
  jobId: string;
  conversationId: string;
  prompt: string;
  state: JobRecord["state"];
  progress: number | null;
  outputRefs: string[];
  errorMessage?: string;
}

/** Persisted job records -> queue rows (survives reopen/update). */
export function mediaJobViews(jobs: readonly JobRecord[]): MediaJobView[] {
  const views: MediaJobView[] = [];
  for (const job of jobs) {
    if (job.kind !== IMAGE_GENERATE_KIND) continue;
    const snapshot = MediaSnapshotSchema.safeParse(job.input);
    if (!snapshot.success) continue;
    views.push({
      jobId: job.id,
      conversationId: snapshot.data.conversationId,
      prompt: snapshot.data.prompt,
      state: job.state,
      progress: job.progress,
      outputRefs: stringRefs(job.result),
      ...(job.error === undefined
        ? {}
        : { errorMessage: errorText(job.error) }),
    });
  }
  return views;
}

export type GalleryScope =
  | { kind: "global" }
  | { kind: "conversation"; conversationId: string };

export interface GalleryAsset {
  jobId: string;
  ref: string;
  conversationId: string;
  prompt: string;
  artifact: MediaArtifact;
}

/**
 * Completed outputs as gallery tiles. Ref names drive artifact preview
 * metadata (MIME + playable duration) via extension sniffing.
 */
export function galleryAssets(
  views: readonly MediaJobView[],
  scope: GalleryScope,
): GalleryAsset[] {
  const assets: GalleryAsset[] = [];
  for (const view of views) {
    if (view.state !== "completed") continue;
    if (
      scope.kind === "conversation" &&
      view.conversationId !== scope.conversationId
    )
      continue;
    for (const ref of view.outputRefs)
      assets.push({
        jobId: view.jobId,
        ref,
        conversationId: view.conversationId,
        prompt: view.prompt,
        artifact: recognizeArtifact(ref, new Uint8Array(0)),
      });
  }
  return assets;
}

export interface ReviewRow {
  draftId: string;
  conversationId: string;
  prompt: string;
  createdAt: string;
}

export function reviewRows(
  drafts: readonly MediaReviewDraft[],
): ReviewRow[] {
  return drafts.map((draft) => ({
    draftId: draft.id,
    conversationId: draft.snapshot.conversationId,
    prompt: draft.snapshot.prompt,
    createdAt: draft.createdAt,
  }));
}

/** One-line user feedback after requestGeneration. */
export function outcomeNote(outcome: MediaRequestOutcome): string {
  switch (outcome.kind) {
    case "job":
      return "Added to the media queue.";
    case "review":
      return "Saved as a prompt draft — approve it below to generate.";
    case "suppressed":
      return outcome.reason;
  }
}

export const DEFAULT_WORKFLOW = {
  name: "comfy-default",
  definition: {},
};
