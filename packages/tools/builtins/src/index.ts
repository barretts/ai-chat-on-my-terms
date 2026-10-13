import type { PortResult } from "@locallab/contracts/ports";
import type { RegisteredTool, ToolExecutionContext } from "@locallab/tools-engine";

/** Stable identity for the built-in tool server; never regenerated per install. */
export const BUILTIN_TOOL_SERVER_ID =
  "00000000-0000-7000-8000-000000000088";
export const CURRENT_TIME_TOOL = "current_time";

/** Aliases are for settings/display matching only; the registry always uses
 * the canonical name, and friendly renames never change tool identity. */
export const CURRENT_TIME_TOOL_ALIASES = Object.freeze(
  ["get_current_time", "current_date"] as const,
);

export interface CurrentTimeToolOptions {
  clock?: () => number;
  timeZone?: string;
  locale?: string;
}

export function createCurrentTimeTool(
  options: CurrentTimeToolOptions = {},
): RegisteredTool {
  return {
    name: CURRENT_TIME_TOOL,
    serverId: BUILTIN_TOOL_SERVER_ID,
    description:
      "Reports the current date and time as an ISO 8601 timestamp plus a local wall-clock reading in the configured time zone.",
    parameters: Object.freeze({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    enabled: true,
    parseInput: (input) => {
      if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Object.keys(input).length > 0
      )
        throw new Error(
          `The ${CURRENT_TIME_TOOL} arguments must be a complete JSON object with only the documented fields.`,
        );
      return {};
    },
    execute: async (input, context: ToolExecutionContext) => {
      if (context.signal.aborted)
        return {
          ok: false,
          error: {
            code: "canceled",
            message: "The request was canceled before it started.",
            recoverable: true,
          },
        };
      if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input) ||
        Object.keys(input).length > 0
      )
        return {
          ok: false,
          error: {
            code: "malformed",
            message:
              "The current_time arguments must be a complete JSON object with only the documented fields.",
            recoverable: true,
          },
        };
      const clock = options.clock ?? Date.now;
      const timeZone =
        options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
      const locale =
        options.locale ?? new Intl.DateTimeFormat().resolvedOptions().locale;
      const date = new Date(clock());
      let local: string;
      try {
        local = new Intl.DateTimeFormat(locale, {
          timeZone,
          dateStyle: "full",
          timeStyle: "medium",
        }).format(date);
      } catch {
        return {
          ok: false,
          error: {
            code: "malformed",
            message:
              "The configured time zone is not available on this device.",
            recoverable: true,
          },
        };
      }
      return {
        ok: true,
        value: {
          iso: date.toISOString(),
          local,
          timeZone,
          locale,
        },
      };
    },
  };
}
