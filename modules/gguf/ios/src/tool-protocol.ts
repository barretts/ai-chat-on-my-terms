import type { RunRequest } from "@locallab/contracts/run-events";
import type { RNLlamaOAICompatibleMessage } from "llama.rn";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function malformed(message: string): never {
  throw Object.assign(new Error(message), { code: "malformed" });
}

function argumentsObject(value: unknown): RecordValue {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      malformed("Native tool arguments must contain valid JSON.");
    }
  }
  if (!record(parsed))
    malformed("Native tool arguments must be a JSON object.");
  return parsed;
}

/** Preserve the shared tool loop's structured history for the GGUF chat template. */
export function nativeChatRequest(request: RunRequest) {
  const messages = request.context.flatMap<RNLlamaOAICompatibleMessage>(
    ({ kind, value }) => {
      if (kind === "tool-definitions") return [];
      if (kind === "tool") {
        if (
          !record(value) ||
          typeof value.tool_call_id !== "string" ||
          !value.tool_call_id
        )
          malformed("Native tool results require a tool_call_id.");
        return [
          {
            role: "tool",
            tool_call_id: value.tool_call_id,
            ...(typeof value.name === "string" ? { name: value.name } : {}),
            content:
              typeof value.content === "string"
                ? value.content
                : JSON.stringify(value.content ?? value.output ?? null),
          },
        ];
      }
      if (!["system", "developer", "user", "assistant", "text"].includes(kind))
        return [];
      const calls =
        kind === "assistant" && record(value) && Array.isArray(value.tool_calls)
          ? value.tool_calls.map((call) => {
              if (
                !record(call) ||
                typeof call.id !== "string" ||
                !call.id ||
                !record(call.function) ||
                typeof call.function.name !== "string"
              )
                malformed(
                  "Saved native tool calls require an ID and function name.",
                );
              return {
                id: call.id,
                type: "function",
                function: {
                  name: call.function.name,
                  arguments: JSON.stringify(
                    argumentsObject(call.function.arguments),
                  ),
                },
              };
            })
          : [];
      return [
        {
          role: kind === "text" ? "user" : kind,
          content:
            typeof value === "string"
              ? value
              : record(value)
                ? typeof value.content === "string"
                  ? value.content
                  : typeof value.text === "string"
                    ? value.text
                    : ""
                : "",
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(record(value) && typeof value.reasoning_content === "string"
            ? { reasoning_content: value.reasoning_content }
            : {}),
        },
      ];
    },
  );
  const definitions = request.context.find(
    (item) => item.kind === "tool-definitions",
  )?.value;
  const tools = Array.isArray(definitions)
    ? definitions.flatMap((definition) =>
        record(definition) &&
        typeof definition.name === "string" &&
        request.permittedTools.includes(definition.name)
          ? [
              {
                type: "function",
                function: {
                  name: definition.name,
                  description:
                    typeof definition.description === "string"
                      ? definition.description
                      : "",
                  parameters: record(definition.parameters)
                    ? definition.parameters
                    : { type: "object", properties: {} },
                },
              },
            ]
          : [],
      )
    : [];
  return { messages, tools };
}

/** Only complete, parsed native calls enter the app's validated tool loop. */
export function nativeToolCalls(
  value: unknown,
  request: RunRequest,
  allowed: readonly string[],
) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) malformed("Native tool calls must be an array.");
  return value.map((call, index) => {
    if (
      !record(call) ||
      call.type !== "function" ||
      !record(call.function) ||
      typeof call.function.name !== "string"
    )
      malformed("Native runtime returned an invalid function call.");
    const name = call.function.name;
    if (!allowed.includes(name))
      throw Object.assign(
        new Error(`Native model requested an unpermitted function: ${name}.`),
        { code: "permission" },
      );
    const input = argumentsObject(call.function.arguments);
    const invocationId = callId(`${request.runId}:${index}:${name}`);
    return { invocationId, name, input };
  });
}

// Match the shared UUIDv7 event contract without trusting native call IDs.
function callId(seed: string): string {
  let tail = "";
  for (let lane = 0; lane < 3; lane++) {
    let hash = 2166136261 ^ Math.imul(lane + 1, 0x9e3779b9);
    for (let index = 0; index < seed.length; index++)
      hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    tail += ((hash ^ (hash >>> 16)) >>> 0).toString(16).padStart(8, "0");
  }
  return `${seed.slice(0, 13)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18)}`;
}
