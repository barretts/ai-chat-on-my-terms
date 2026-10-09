import type {
  RegisteredTool,
  ToolExecutionContext,
} from "@locallab/tools-engine";
import type { PortResult } from "@locallab/contracts/ports";
import { errorDetails } from "@locallab/network-http";
import { sanitizeDiagnosticText } from "../diagnostics/sanitization";
import {
  validateWorkspacePath,
  WorkspaceFileError,
  type WorkspaceFilesStore,
  type WorkspaceWriteInput,
} from "./store";

export const WORKSPACE_TOOL_NAMES = [
  "workspace_list_files",
  "workspace_read_file",
  "workspace_write_file",
] as const;

export const WORKSPACE_READ_LIMITS = Object.freeze({
  defaultCharacters: 16_384,
  maxCharacters: 32_768,
});

const defaultServerId = "00000000-0000-7000-8000-000000000075";

function object(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.keys(input).some((key) => !allowedKeys.includes(key))
  )
    throw new WorkspaceFileError(
      "malformed",
      "The file tool arguments must be a complete JSON object with only the documented fields.",
    );
  return input as Record<string, unknown>;
}

function readInput(input: unknown): {
  path: string;
  offset: number;
  maxCharacters: number;
} {
  const value = object(input, ["path", "offset", "maxCharacters"]);
  const offset = value.offset === undefined ? 0 : value.offset;
  const maxCharacters =
    value.maxCharacters === undefined
      ? WORKSPACE_READ_LIMITS.defaultCharacters
      : value.maxCharacters;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
    throw new WorkspaceFileError(
      "malformed",
      "The file reading offset must be a non-negative integer returned as nextOffset by the previous read.",
    );
  if (
    typeof maxCharacters !== "number" ||
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < 1 ||
    maxCharacters > WORKSPACE_READ_LIMITS.maxCharacters
  )
    throw new WorkspaceFileError(
      "malformed",
      `Read between 1 and ${WORKSPACE_READ_LIMITS.maxCharacters} characters at a time. Use nextOffset to read the next part.`,
    );
  return { path: validateWorkspacePath(value.path), offset, maxCharacters };
}

function writeInput(input: unknown): WorkspaceWriteInput {
  const value = object(input, ["path", "content", "expectedRevision"]);
  if (typeof value.content !== "string")
    throw new WorkspaceFileError(
      "malformed",
      "workspace_write_file requires complete text in content.",
    );
  if (
    value.expectedRevision !== undefined &&
    (typeof value.expectedRevision !== "number" ||
      !Number.isSafeInteger(value.expectedRevision) ||
      value.expectedRevision < 1)
  )
    throw new WorkspaceFileError(
      "malformed",
      "expectedRevision must be the positive integer returned by workspace_read_file or workspace_list_files.",
    );
  return {
    path: validateWorkspacePath(value.path),
    content: value.content,
    ...(typeof value.expectedRevision === "number"
      ? { expectedRevision: value.expectedRevision }
      : {}),
  };
}

/** Tools can access only this store's chat. Export and filesystem access remain user actions. */
export function createWorkspaceTools(
  store: WorkspaceFilesStore,
  options: { serverId?: string } = {},
): readonly RegisteredTool[] {
  const execute =
    (
      operation: (
        input: unknown,
        context: ToolExecutionContext,
      ) => Promise<unknown>,
    ): RegisteredTool["execute"] =>
    async (input, context): Promise<PortResult<unknown>> => {
      if (context.conversationId !== store.conversationId)
        return {
          ok: false,
          error: {
            code: "permission",
            message:
              "The file workspace belongs to a different chat. No file was read or changed.",
            recoverable: false,
          },
        };
      if (context.signal.aborted)
        return {
          ok: false,
          error: {
            code: "canceled",
            message:
              "The file operation was canceled. Saved files have been kept.",
            recoverable: true,
          },
        };
      try {
        return { ok: true, value: await operation(input, context) };
      } catch (cause) {
        const code =
          cause instanceof WorkspaceFileError &&
          ["quota", "canceled"].includes(cause.code)
            ? (cause.code as "quota" | "canceled")
            : "malformed";
        return {
          ok: false,
          error: {
            code,
            message: sanitizeDiagnosticText(errorDetails(cause)),
            recoverable: true,
          },
        };
      }
    };
  const base = { serverId: options.serverId ?? defaultServerId, enabled: true };
  const pathProperty = {
    type: "string",
    maxLength: 255,
    description:
      "Relative .md or .txt filename, for example notes/plan.md. Use letters, digits, dots, underscores or hyphens. Never an absolute path or parent directory.",
  };
  return [
    {
      ...base,
      name: WORKSPACE_TOOL_NAMES[0],
      description:
        "List the Markdown and text files saved in this chat's workspace, including the revision needed to update each file.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      parseInput: (input) => object(input, []),
      execute: execute(async (input) => {
        object(input, []);
        return { files: await store.list() };
      }),
    },
    {
      ...base,
      name: WORKSPACE_TOOL_NAMES[1],
      description:
        "Read a bounded part of one Markdown or text file from this chat's workspace, with its revision and total size. Use nextOffset to continue reading when hasMore is true. Read its current revision before replacing it.",
      parameters: {
        type: "object",
        properties: {
          path: pathProperty,
          offset: {
            type: "integer",
            minimum: 0,
            description:
              "Unicode character offset. Defaults to 0; use nextOffset from the previous read for the next part.",
          },
          maxCharacters: {
            type: "integer",
            minimum: 1,
            maximum: WORKSPACE_READ_LIMITS.maxCharacters,
            description: `Maximum Unicode characters to return. Defaults to ${WORKSPACE_READ_LIMITS.defaultCharacters}.`,
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      parseInput: readInput,
      execute: execute(async (input) => {
        const { path, offset, maxCharacters } = readInput(input);
        const file = await store.read(path);
        if (!file)
          throw new WorkspaceFileError(
            "missing-file",
            `The file ${path} does not exist in this chat. Use workspace_list_files to see available files.`,
          );
        const characters = Array.from(file.content);
        if (offset > characters.length)
          throw new WorkspaceFileError(
            "malformed",
            `The file contains ${characters.length} Unicode characters. Read from an offset between 0 and ${characters.length}.`,
          );
        const end = Math.min(offset + maxCharacters, characters.length);
        const hasMore = end < characters.length;
        return {
          ...file,
          content: characters.slice(offset, end).join(""),
          offset,
          totalCharacters: characters.length,
          totalBytes: file.byteLength,
          hasMore,
          nextOffset: hasMore ? end : null,
        };
      }),
    },
    {
      ...base,
      name: WORKSPACE_TOOL_NAMES[2],
      description:
        "Save complete Markdown or plain text in this chat's workspace. Omit expectedRevision for a new file; replacing a file requires its current revision. When your tool format uses XML parameters, encode content as a quoted JSON string with escaped newlines and quotes so whitespace and literal closing tags are preserved. Saved files remain until the chat is deleted.",
      parameters: {
        type: "object",
        properties: {
          path: pathProperty,
          content: {
            type: "string",
            description:
              "Complete file content, preserving Markdown, XML, Unicode and newlines.",
          },
          expectedRevision: {
            type: "integer",
            minimum: 1,
            description:
              "The current revision from reading/listing an existing file. Omit only when creating a new file.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      parseInput: writeInput,
      execute: execute(async (input, context) => {
        const file = await store.write(writeInput(input), context.signal);
        const { content: _content, ...metadata } = file;
        return { saved: true, ...metadata };
      }),
    },
  ];
}
