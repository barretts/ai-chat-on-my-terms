import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent } from "@locallab/contracts/run-events";
import { WEB_FETCH_TOOL } from "./web-research";
import { WEB_SEARCH_TOOL } from "./web-research-tools";

type EventPayload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "sequence" | "timestamp" | "participantId">
    : never
  : never;

interface DerivedSource {
  url: string;
  title?: string;
}

function validSource(value: unknown): DerivedSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.url !== "string" || !item.url) return undefined;
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const title =
    typeof item.title === "string" && item.title.trim()
      ? item.title.trim().slice(0, 200)
      : undefined;
  return { url: item.url, ...(title ? { title } : {}) };
}

function sourcesFromOutput(output: unknown): DerivedSource[] {
  if (!output || typeof output !== "object" || Array.isArray(output))
    return [];
  const record = output as Record<string, unknown>;
  const candidates = Array.isArray(record.results)
    ? record.results
    : record.source !== undefined
      ? [record.source]
      : [];
  return candidates
    .map(validSource)
    .filter((source): source is DerivedSource => Boolean(source));
}

/** A replayed run already carries finished tool exchanges in its context. */
function sourcesFromReplay(
  context: readonly { kind: string; value: unknown }[],
): DerivedSource[] {
  const sources: DerivedSource[] = [];
  for (const item of context) {
    if (item.kind !== "tool" || !item.value || typeof item.value !== "object")
      continue;
    const call = item.value as Record<string, unknown>;
    if (call.name !== WEB_SEARCH_TOOL && call.name !== WEB_FETCH_TOOL)
      continue;
    if (typeof call.content !== "string") continue;
    let output: unknown;
    try {
      output = JSON.parse(call.content);
    } catch {
      continue;
    }
    sources.push(...sourcesFromOutput(output));
  }
  return sources;
}

/**
 * Derives Source events from validated web tool results so autonomous
 * research cites the same way the manual prepass does. Events are
 * resequenced monotonically with exactly one terminal event, and replayed
 * runs re-emit their saved sources on reopen.
 */
export function withWebResearchToolSources<C>(
  provider: ProviderPort<C>,
): ProviderPort<C> {
  return {
    listModels: provider.listModels.bind(provider),
    getCapabilities: provider.getCapabilities.bind(provider),
    ...(provider.dispose ? { dispose: provider.dispose.bind(provider) } : {}),
    async *startRun(request, signal) {
      let sequence = 0;
      const seen = new Set<string>();
      const webCalls = new Set<string>();
      const emit = (payload: EventPayload): RunEvent =>
        ({
          ...payload,
          runId: request.runId,
          sequence: sequence++,
          timestamp: new Date().toISOString(),
        }) as RunEvent;
      const dedupe = (source: DerivedSource) => {
        if (seen.has(source.url)) return undefined;
        seen.add(source.url);
        return emit({ type: "Source", ...source });
      };
      for (const source of sourcesFromReplay(request.context)) {
        const event = dedupe(source);
        if (event) yield event;
      }
      const inner = provider
        .startRun(request, signal)
        [Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await inner.next();
          if (next.done) return;
          const {
            runId: _runId,
            sequence: _sequence,
            timestamp: _timestamp,
            participantId,
            ...payload
          } = next.value;
          yield emit({
            ...payload,
            ...(participantId ? { participantId } : {}),
          });
          if (
            payload.type === "ToolCall" &&
            (payload.name === WEB_SEARCH_TOOL ||
              payload.name === WEB_FETCH_TOOL)
          )
            webCalls.add(payload.invocationId);
          else if (
            payload.type === "ToolResult" &&
            webCalls.has(payload.invocationId)
          ) {
            for (const source of sourcesFromOutput(payload.output)) {
              const event = dedupe(source);
              if (event) yield event;
            }
          }
          if (
            payload.type === "RunCompleted" ||
            payload.type === "RunCanceled" ||
            payload.type === "RunFailed"
          )
            return;
        }
      } finally {
        void inner.return?.().catch(() => {});
      }
    },
  };
}
