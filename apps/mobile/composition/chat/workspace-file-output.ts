import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent } from "@locallab/contracts/run-events";
import {
  localFailureCause,
  retainLocalFailureCause,
} from "@locallab/contracts/local-failure-details";
import { errorDetails } from "@locallab/network-http";
import { strToU8 } from "fflate";
import { WORKSPACE_LIMITS } from "../../features/workspace-files/store";
import { sanitizeDiagnosticText } from "../../features/diagnostics/sanitization";

export interface WorkspaceOutputStore {
  write(
    input: { path: string; content: string; expectedRevision?: number },
    signal?: AbortSignal,
  ): Promise<{ path: string; revision: number; byteLength: number }>;
}

function forwardEvent(
  event: RunEvent,
  runId: string,
  sequence: number,
): RunEvent {
  const next: RunEvent =
    event.type === "RunFailed"
      ? {
          ...event,
          runId,
          sequence,
          error: {
            ...event.error,
            message: sanitizeDiagnosticText(event.error.message),
          },
        }
      : { ...event, runId, sequence };
  const cause = localFailureCause(event);
  if (cause !== undefined) retainLocalFailureCause(next, cause);
  if (event.type === "RunFailed" && next.type === "RunFailed") {
    const errorCause = localFailureCause(event.error);
    if (errorCause !== undefined)
      retainLocalFailureCause(next.error, errorCause);
  }
  return next;
}

/** Strip only a whole-response Markdown/text wrapper; retain every inner fence and line ending. */
function documentContent(content: string): string {
  const opening =
    /^[ \t\r\n]*(`{3,}|~{3,})(?:markdown|md|text|txt|plaintext)?[ \t]*\r?\n/i.exec(
      content,
    );
  if (!opening) return content;
  const fence = opening[1]!;
  const closing = new RegExp(
    `(?:^|\\n)[ \\t]*${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*(?:\\r?\\n)?[ \\t\\r\\n]*$`,
  ).exec(content);
  if (!closing || closing.index < opening[0].length) return content;
  // Keep the final content newline: only the opening and closing wrapper lines disappear.
  return content.slice(
    opening[0].length,
    closing.index + (content[closing.index] === "\n" ? 1 : 0),
  );
}

function truncated(finishReason?: string): boolean {
  return /length|max[_ -]?(?:tokens|output)|token[_ -]?limit|content[_ -]?filter|incomplete|tool[_ -]?calls/i.test(
    finishReason ?? "",
  );
}

function completeFailureDetails(cause: unknown): string {
  const messages = [errorDetails(cause)];
  const visited = new Set<unknown>();
  let current = cause;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const detail = current as {
      status?: unknown;
      response?: {
        status?: unknown;
        statusText?: unknown;
        contentType?: unknown;
        body?: unknown;
      };
      responseBody?: unknown;
      cause?: unknown;
    };
    const response = detail.response;
    const status = response?.status ?? detail.status;
    if (
      typeof status === "number" &&
      !messages.join("\n").includes(`HTTP ${status}`)
    )
      messages.push(
        `HTTP ${status}${typeof response?.statusText === "string" ? ` ${response.statusText}` : ""}`,
      );
    if (
      typeof response?.contentType === "string" &&
      !messages.join("\n").includes(response.contentType)
    )
      messages.push(`Content-Type: ${response.contentType}`);
    const body = response?.body ?? detail.responseBody;
    if (body !== undefined) {
      const text = typeof body === "string" ? body : errorDetails(body);
      if (!messages.join("\n").includes(text))
        messages.push(`Response body:\n${text}`);
    }
    current = detail.cause;
  }
  return sanitizeDiagnosticText(messages.join("\n"));
}

function failureEvent(
  runId: string,
  sequence: number,
  cause: unknown,
  code = "workspace-write",
): RunEvent {
  const error = {
    code,
    message: completeFailureDetails(cause),
    recoverable: true,
  };
  retainLocalFailureCause(error, cause);
  const failure: RunEvent = {
    runId,
    sequence,
    timestamp: new Date().toISOString(),
    type: "RunFailed",
    error,
  };
  retainLocalFailureCause(failure, cause);
  return failure;
}

/** Text-only models can create documents too; commit only a complete, uncanceled response. */
export function withWorkspaceFileOutput<C>(
  provider: ProviderPort<C>,
  options: {
    store: WorkspaceOutputStore;
    path: string;
    expectedRevision?: number;
    createId(): string;
  },
): ProviderPort<C> {
  return {
    listModels: provider.listModels.bind(provider),
    getCapabilities: provider.getCapabilities.bind(provider),
    ...(provider.dispose ? { dispose: provider.dispose.bind(provider) } : {}),
    async *startRun(request, signal) {
      let sequence = 0;
      const chunks: string[] = [];
      let byteLength = 0;
      let pendingSurrogate = "";
      let terminalEmitted = false;
      let writingInvocation: string | undefined;
      const forward = (event: RunEvent): RunEvent =>
        forwardEvent(event, request.runId, sequence++);
      const base = () => ({
        runId: request.runId,
        sequence: sequence++,
        timestamp: new Date().toISOString(),
      });
      try {
        if (signal.aborted) {
          terminalEmitted = true;
          yield {
            ...base(),
            type: "RunCanceled",
            reason: "File creation canceled before saving.",
          };
          return;
        }
        for await (const event of provider.startRun(request, signal)) {
          if (signal.aborted) {
            terminalEmitted = true;
            yield {
              ...base(),
              type: "RunCanceled",
              reason: "File creation canceled before saving.",
            };
            return;
          }
          if (event.type === "TextDelta") {
            chunks.push(event.text);
            const chunk = pendingSurrogate + event.text;
            pendingSurrogate = /[\uD800-\uDBFF]$/.test(chunk)
              ? chunk.slice(-1)
              : "";
            byteLength += strToU8(
              pendingSurrogate ? chunk.slice(0, -1) : chunk,
            ).byteLength;
            // Allow a small outer-fence envelope; saved content still has the exact file limit.
            if (
              byteLength + strToU8(pendingSurrogate).byteLength >
              WORKSPACE_LIMITS.fileBytes + 1024
            )
              throw new Error(
                "The generated file exceeds 256 KiB. It was not saved. Ask for a smaller document.",
              );
          }
          if (event.type !== "RunCompleted") {
            if (event.type === "RunFailed" || event.type === "RunCanceled")
              terminalEmitted = true;
            yield forward(event);
            if (event.type === "RunFailed" || event.type === "RunCanceled")
              return;
            continue;
          }
          if (signal.aborted) {
            terminalEmitted = true;
            yield {
              ...base(),
              type: "RunCanceled",
              reason: "File creation canceled before saving.",
            };
            return;
          }
          if (truncated(event.finishReason))
            throw new Error(
              "The response did not finish the document, so the incomplete file was not saved. Increase Maximum output tokens or ask for a shorter document.",
            );
          const content = chunks.join("");
          if (!content.trim())
            throw new Error(
              "The model returned no document content. The file was not saved.",
            );
          const document = documentContent(content);
          if (!document.trim())
            throw new Error(
              "The model returned no document content. The file was not saved.",
            );
          if (strToU8(document).byteLength > WORKSPACE_LIMITS.fileBytes)
            throw new Error(
              "The generated file exceeds 256 KiB. It was not saved. Ask for a smaller document.",
            );
          const invocationId = options.createId();
          writingInvocation = invocationId;
          yield {
            ...base(),
            type: "ToolCall",
            invocationId,
            name: "workspace_write_file",
            input: {
              path: options.path,
              content: document,
              ...(options.expectedRevision !== undefined
                ? { expectedRevision: options.expectedRevision }
                : {}),
            },
          };
          const saved = await options.store.write(
            {
              path: options.path,
              content: document,
              ...(options.expectedRevision !== undefined
                ? { expectedRevision: options.expectedRevision }
                : {}),
            },
            signal,
          );
          writingInvocation = undefined;
          yield {
            ...base(),
            type: "ToolResult",
            invocationId,
            output: {
              saved: true,
              path: saved.path,
              revision: saved.revision,
              byteLength: saved.byteLength,
            },
          };
          terminalEmitted = true;
          yield forward(event);
          return;
        }
        throw new Error(
          "The model response ended before completion. The file was not saved; retry your request.",
        );
      } catch (cause) {
        // A provider may throw while its iterator closes after a terminal event.
        if (terminalEmitted) return;
        terminalEmitted = true;
        if (signal.aborted) {
          yield {
            ...base(),
            type: "RunCanceled",
            reason: "File creation canceled.",
          };
          return;
        }
        if (writingInvocation)
          yield {
            ...base(),
            type: "ToolResult",
            invocationId: writingInvocation,
            output: { error: completeFailureDetails(cause) },
          };
        yield failureEvent(request.runId, sequence++, cause);
      }
    },
  };
}

/** Native tool models must actually save the named file before reporting completion. */
export function withVerifiedWorkspaceFileSave<C>(
  provider: ProviderPort<C>,
  options: { path: string },
): ProviderPort<C> {
  return {
    listModels: provider.listModels.bind(provider),
    getCapabilities: provider.getCapabilities.bind(provider),
    ...(provider.dispose ? { dispose: provider.dispose.bind(provider) } : {}),
    async *startRun(request, signal) {
      let sequence = 0;
      let saved = false;
      let terminalEmitted = false;
      const writes = new Set<string>();
      const samePath = (path: unknown) =>
        typeof path === "string" &&
        path.toLowerCase() === options.path.toLowerCase();
      try {
        if (signal.aborted) {
          terminalEmitted = true;
          yield {
            runId: request.runId,
            sequence: sequence++,
            timestamp: new Date().toISOString(),
            type: "RunCanceled",
            reason: "File response canceled before saving.",
          };
          return;
        }
        for await (const event of provider.startRun(request, signal)) {
          if (signal.aborted) {
            terminalEmitted = true;
            yield {
              runId: request.runId,
              sequence: sequence++,
              timestamp: new Date().toISOString(),
              type: "RunCanceled",
              reason:
                "File response canceled. Any completed saved writes remain in Files.",
            };
            return;
          }
          if (
            event.type === "ToolCall" &&
            event.name === "workspace_write_file" &&
            event.input &&
            typeof event.input === "object" &&
            samePath((event.input as { path?: unknown }).path)
          )
            writes.add(event.invocationId);
          if (
            event.type === "ToolResult" &&
            writes.delete(event.invocationId)
          ) {
            const output = event.output as {
              saved?: unknown;
              path?: unknown;
              revision?: unknown;
            } | null;
            if (
              output &&
              output.saved === true &&
              samePath(output.path) &&
              typeof output.revision === "number" &&
              Number.isSafeInteger(output.revision) &&
              output.revision > 0
            )
              saved = true;
          }
          if (event.type === "RunCompleted" && !saved) {
            terminalEmitted = true;
            const cause = new Error(
              `The model finished without saving ${options.path} in this chat. Its reply is kept, but no requested file was created. Retry the file request or use Files → New file to save the text manually.`,
            );
            yield failureEvent(
              request.runId,
              sequence++,
              cause,
              "workspace-not-saved",
            );
            return;
          }
          if (
            event.type === "RunCompleted" ||
            event.type === "RunFailed" ||
            event.type === "RunCanceled"
          )
            terminalEmitted = true;
          yield forwardEvent(event, request.runId, sequence++);
          if (terminalEmitted) return;
        }
        throw new Error(
          "The model response ended before completion. Check Files for any saved writes, then retry your request.",
        );
      } catch (cause) {
        if (terminalEmitted) return;
        if (signal.aborted) {
          yield {
            runId: request.runId,
            sequence: sequence++,
            timestamp: new Date().toISOString(),
            type: "RunCanceled",
            reason:
              "File response canceled. Any completed saved writes remain in Files.",
          };
          return;
        }
        yield failureEvent(
          request.runId,
          sequence++,
          cause,
          "workspace-not-saved",
        );
      }
    },
  };
}
