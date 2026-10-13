import type { PortResult, TypedErrorCode } from "@locallab/contracts/ports";
import type { RegisteredTool, ToolExecutionContext } from "@locallab/tools-engine";
import { McpHttpClient, type McpCallResult } from "./client";
import { mcpErrorResult, type McpErrorCode } from "./errors";

/** Maps this package's honest error codes onto the engine's PortResult code
 * enum so remote failures cross the boundary without lying about cause. */
const PORT_ERROR_CODES: Record<McpErrorCode, TypedErrorCode> = {
  offline: "offline",
  auth: "unauthorized",
  timeout: "timeout",
  protocol: "malformed",
  unsupported: "unsupported",
  canceled: "canceled",
};

/** One-level JSON type check against a schema property declaration. */
function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

/** Discovers the client's tools (initializing when needed) and maps every
 * accepted tool onto a tool-engine RegisteredTool.
 *
 * Identity rules: RegisteredTool.name is the ORIGINAL remote name — the
 * `labels` option exists only for display matching elsewhere and NEVER
 * renames a tool; serverId is the config's stable id (overridable via
 * `opts.serverId`). parseInput performs one-level JSON-schema-lite
 * validation (required properties present; declared top-level property
 * types; extra properties allowed) and throws honest Errors. execute maps
 * tools/call outcomes onto PortResult: transport failures via
 * mcpErrorResult with engine-compatible codes; MCP isError answers as
 * non-recoverable "malformed" with the first text content as the message;
 * success yields `{ text }` (text parts joined with newlines) plus
 * `structuredContent` only when the server sent it. */
export async function createMcpTools(
  client: McpHttpClient,
  opts: { serverId?: string; labels?: Record<string, string> } = {},
): Promise<RegisteredTool[]> {
  const signal = new AbortController().signal;
  if (!client.isInitialized) await client.initialize(signal);
  const discovery = await client.discoverTools(signal);
  const serverId = opts.serverId ?? client.config.id;
  const tools: RegisteredTool[] = [];
  for (const tool of discovery.tools) {
    const parameters = tool.inputSchema;
    const description = tool.description ?? tool.title ?? tool.name;
    const name = tool.name;
    const registered: RegisteredTool = {
      name,
      serverId,
      description,
      parameters,
      enabled: true,
      parseInput: (input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input)
        )
          throw new Error(`The ${name} arguments must be a JSON object.`);
        const args: Record<string, unknown> = input as Record<string, unknown>;
        if (Array.isArray(parameters.required)) {
          for (const key of parameters.required) {
            if (typeof key === "string" && !(key in args))
              throw new Error(
                `The ${name} arguments are missing the required property "${key}".`,
              );
          }
        }
        const properties = parameters.properties;
        if (
          typeof properties === "object" &&
          properties !== null &&
          !Array.isArray(properties)
        ) {
          for (const [key, declaration] of Object.entries(properties)) {
            if (
              typeof declaration !== "object" ||
              declaration === null ||
              typeof declaration.type !== "string"
            )
              continue;
            if (key in args && !matchesJsonType(args[key], declaration.type))
              throw new Error(
                `The ${name} argument "${key}" must be of JSON type ${declaration.type}.`,
              );
          }
        }
        return args;
      },
      execute: async (input, context: ToolExecutionContext) => {
        const args: Record<string, unknown> =
          typeof input === "object" &&
          input !== null &&
          !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        let call: McpCallResult;
        try {
          call = await client.callTool(name, args, context.signal);
        } catch (cause) {
          const mapped = mcpErrorResult(cause);
          return {
            ok: false,
            error: {
              code: PORT_ERROR_CODES[mapped.error.code],
              message: mapped.error.message,
              recoverable: mapped.error.recoverable,
            },
          };
        }
        const textParts: string[] = [];
        for (const part of call.content) {
          if (part.type === "text") textParts.push(part.text ?? "");
        }
        if (call.isError === true)
          return {
            ok: false,
            error: {
              code: "malformed",
              message:
                (textParts[0] ?? "") ||
                `The remote MCP tool ${name} reported an error.`,
              recoverable: false,
            },
          };
        const value: { text: string; structuredContent?: unknown } = {
          text: textParts.join("\n"),
        };
        if (call.structuredContent !== undefined)
          value.structuredContent = call.structuredContent;
        return { ok: true, value };
      },
    };
    tools.push(registered);
  }
  return tools;
}
