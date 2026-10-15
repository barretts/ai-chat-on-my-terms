import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Switch, Text } from "react-native-paper";
import {
  NativeButton,
  NativeDropdown,
  NativeInput,
  NativeSurface,
  NativeText,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import type { JobScheduler } from "@locallab/jobs";
import {
  MediaSettingsSchema,
  type MediaJobService,
  type MediaReviewStore,
  type MediaSettingsStore,
} from "@locallab/media-engine";
import {
  DEFAULT_WORKFLOW,
  galleryAssets,
  mediaJobViews,
  outcomeNote,
  reviewRows,
  type GalleryScope,
  type MediaJobView,
  type ReviewRow,
} from ".";

export interface MediaPanelProps {
  service: MediaJobService;
  scheduler: JobScheduler;
  settings: MediaSettingsStore;
  reviews: MediaReviewStore;
  workflows: readonly { name: string; definition: Record<string, unknown> }[];
  conversationId: string;
}

const durationLabel = (ms?: number): string =>
  ms === undefined ? "" : ms >= 1000 ? ` · ${(ms / 1000).toFixed(1)}s` : ` · ${ms}ms`;

export function MediaPanel(props: MediaPanelProps) {
  const { phone } = useWorkspaceLayout();
  const [settings, setSettings] = useState(() =>
    MediaSettingsSchema.parse({
      enabled: false,
      promptReview: false,
      autoGenerate: false,
    }),
  );
  const [views, setViews] = useState<MediaJobView[]>([]);
  const [drafts, setDrafts] = useState<ReviewRow[]>([]);
  const [prompt, setPrompt] = useState("");
  const [workflowName, setWorkflowName] = useState(DEFAULT_WORKFLOW.name);
  const [scope, setScope] = useState<"global" | "conversation">("conversation");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [loaded, draftsNow] = await Promise.all([
      props.settings.load(),
      props.reviews.list(),
    ]);
    setSettings(loaded);
    setViews(mediaJobViews(await props.scheduler.list()));
    setDrafts(reviewRows(draftsNow));
  }, [props.settings, props.reviews, props.scheduler]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveSettings = async (patch: Partial<typeof settings>) => {
    const next = MediaSettingsSchema.parse({ ...settings, ...patch });
    setSettings(next);
    setError("");
    try {
      await props.settings.save(next);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  const generate = async () => {
    if (prompt.trim() === "") return;
    setError("");
    const workflow =
      props.workflows.find((entry) => entry.name === workflowName) ??
      DEFAULT_WORKFLOW;
    try {
      const outcome = await props.service.requestGeneration({
        conversationId: props.conversationId,
        prompt,
        requestedBy: "button",
        workflow,
      });
      setNote(outcomeNote(outcome));
      setPrompt("");
      await refresh();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  const approve = async (draftId: string) => {
    setError("");
    try {
      await props.service.approveReview(draftId);
      setNote("Approved. Added to the media queue.");
      await refresh();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  const discard = async (draftId: string) => {
    setError("");
    try {
      await props.service.cancelReview(draftId);
      await refresh();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  const cancel = async (jobId: string) => {
    setError("");
    try {
      await props.service.cancelJob(jobId);
      await refresh();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  const galleryScope: GalleryScope =
    scope === "conversation"
      ? { kind: "conversation", conversationId: props.conversationId }
      : { kind: "global" };
  const assets = galleryAssets(views, galleryScope);
  const queue = views.filter(
    (view) => view.state === "queued" || view.state === "running",
  );
  const done = views.filter(
    (view) => view.state === "completed" || view.state === "failed",
  );

  return (
    <ScrollView
      style={{ flex: 1 }}
      accessibilityLabel="Media generation panel"
    >
      <View style={{ padding: phone ? 12 : 18, gap: 14 }}>
        <NativeSurface accessibilityLabel="Image settings">
          <Text variant="titleMedium">Image generation</Text>
          <Switch
            accessibilityLabel="Enable image generation"
            value={settings.enabled}
            onValueChange={(value) => void saveSettings({ enabled: value })}
          >
            Enable image generation
          </Switch>
          <Switch
            accessibilityLabel="Ask before generating prompts from chat"
            value={settings.promptReview}
            disabled={!settings.enabled}
            onValueChange={(value) =>
              void saveSettings({ promptReview: value })
            }
          >
            Review prompts before generating
          </Switch>
          <Switch
            accessibilityLabel="Generate automatically from chat requests"
            value={settings.autoGenerate}
            disabled={!settings.enabled}
            onValueChange={(value) =>
              void saveSettings({ autoGenerate: value })
            }
          >
            Auto-generate from chat
          </Switch>
          <NativeDropdown
            label="Workflow"
            value={workflowName}
            options={
              props.workflows.length === 0
                ? [{ value: DEFAULT_WORKFLOW.name, label: "ComfyUI default" }]
                : props.workflows.map((entry) => ({
                    value: entry.name,
                    label: entry.name,
                  }))
            }
            onChange={setWorkflowName}
          />
          <NativeInput
            accessibilityLabel="Image prompt"
            label="Prompt"
            value={prompt}
            onChangeText={setPrompt}
            multiline
          />
          <NativeButton
            accessibilityLabel="Generate image now"
            mode="contained"
            onPress={() => void generate()}
            disabled={!settings.enabled || prompt.trim() === ""}
          >
            Generate
          </NativeButton>
          {note !== "" && (
            <NativeText accessibilityLabel="Last generation result">
              {note}
            </NativeText>
          )}
          {error !== "" && (
            <Text accessibilityRole="alert" accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}
        </NativeSurface>

        {drafts.length > 0 && (
          <NativeSurface accessibilityLabel="Prompt review queue">
            <Text variant="titleMedium">Waiting for approval</Text>
            {drafts.map((draft) => (
              <View
                key={draft.draftId}
                style={{ gap: 6, paddingVertical: 8 }}
              >
                <NativeText accessibilityLabel={`Draft prompt ${draft.prompt}`}>
                  {draft.prompt}
                </NativeText>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <NativeButton
                    accessibilityLabel={`Approve draft ${draft.prompt}`}
                    mode="contained"
                    onPress={() => void approve(draft.draftId)}
                  >
                    Approve
                  </NativeButton>
                  <NativeButton
                    accessibilityLabel={`Discard draft ${draft.prompt}`}
                    onPress={() => void discard(draft.draftId)}
                  >
                    Discard
                  </NativeButton>
                </View>
              </View>
            ))}
          </NativeSurface>
        )}

        <NativeSurface accessibilityLabel="Media job queue">
          <Text variant="titleMedium">Queue</Text>
          {queue.length === 0 && (
            <NativeText accessibilityLabel="Queue is empty">
              Nothing queued.
            </NativeText>
          )}
          {queue.map((view) => (
            <View key={view.jobId} style={{ gap: 6, paddingVertical: 8 }}>
              <NativeText accessibilityLabel={`Queued prompt ${view.prompt}`}>
                {view.prompt}
                {view.state === "running" && view.progress !== null
                  ? ` · ${Math.round(view.progress * 100)}%`
                  : ""}
              </NativeText>
              <NativeButton
                accessibilityLabel={`Cancel job ${view.prompt}`}
                onPress={() => void cancel(view.jobId)}
              >
                Cancel
              </NativeButton>
            </View>
          ))}
          {done.map((view) => (
            <View key={view.jobId} style={{ paddingVertical: 6 }}>
              <NativeText
                accessibilityLabel={`Job ${view.state}: ${view.prompt}`}
              >
                {view.state === "failed"
                  ? `${view.prompt} — ${view.errorMessage ?? "failed"}`
                  : `${view.prompt} — done`}
              </NativeText>
            </View>
          ))}
        </NativeSurface>

        <NativeSurface accessibilityLabel="Generated media gallery">
          <Text variant="titleMedium">Gallery</Text>
          <NativeDropdown
            label="Gallery scope"
            value={scope}
            options={[
              { value: "conversation", label: "This conversation" },
              { value: "global", label: "All conversations" },
            ]}
            onChange={(value) =>
              setScope(value === "global" ? "global" : "conversation")
            }
          />
          {assets.length === 0 && (
            <NativeText accessibilityLabel="Gallery is empty">
              Nothing generated yet.
            </NativeText>
          )}
          {assets.map((asset) => (
            <View
              key={`${asset.jobId}:${asset.ref}`}
              style={{ paddingVertical: 8, gap: 4 }}
            >
              <NativeText
                accessibilityLabel={`${asset.artifact.kind === "video" ? "Video" : "Image"} from ${asset.prompt}`}
              >
                {asset.artifact.kind === "video" ? "▶" : "▣"} {asset.prompt}
                {durationLabel(asset.artifact.durationMs)}
              </NativeText>
              <NativeText accessibilityLabel="Stored output reference">
                {asset.artifact.mimeType} · {asset.ref}
              </NativeText>
            </View>
          ))}
        </NativeSurface>
      </View>
    </ScrollView>
  );
}
