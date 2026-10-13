import { describe, expect, it } from "vitest";
import {
  ToolRegistry,
  type ToolExecutionContext,
} from "@locallab/tools-engine";
import {
  BUILTIN_TOOL_SERVER_ID,
  CURRENT_TIME_TOOL,
  CURRENT_TIME_TOOL_ALIASES,
  createCurrentTimeTool,
} from "../src/index";

// 2026-10-10T06:30:00.000Z — a Saturday in Pacific/Auckland (NZDT, +13:00).
const fixedEpoch = Date.UTC(2026, 9, 10, 6, 30);

function context(
  signal: AbortSignal = new AbortController().signal,
): ToolExecutionContext {
  return {
    invocationId: "0193f2a0-1234-7abc-8def-000000000001",
    conversationId: "0193f2a0-1234-7abc-8def-000000000002",
    runId: "0193f2a0-1234-7abc-8def-000000000003",
    signal,
  };
}

describe("current_time built-in", () => {
  it("registers under the canonical name only", () => {
    const registry = new ToolRegistry();
    const tool = createCurrentTimeTool({ clock: () => fixedEpoch });
    expect(tool.serverId).toBe(BUILTIN_TOOL_SERVER_ID);
    expect(tool.name).toBe(CURRENT_TIME_TOOL);
    expect(tool.enabled).toBe(true);
    registry.register(tool);
    const snapshot = registry.snapshot(
      { globalEnabled: true, capabilities: { tools: "yes" } },
      [CURRENT_TIME_TOOL, ...CURRENT_TIME_TOOL_ALIASES],
    );
    expect(snapshot.map((registered) => registered.name)).toEqual([
      CURRENT_TIME_TOOL,
    ]);
  });

  it("freezes the alias list used for settings/display matching", () => {
    expect(CURRENT_TIME_TOOL_ALIASES).toStrictEqual([
      "get_current_time",
      "current_date",
    ]);
    expect(Object.isFrozen(CURRENT_TIME_TOOL_ALIASES)).toBe(true);
  });

  it("accepts only a plain empty object as arguments", () => {
    const tool = createCurrentTimeTool({ clock: () => fixedEpoch });
    expect(tool.parseInput({})).toEqual({});
    expect(() => tool.parseInput({ extra: 1 })).toThrow(Error);
    expect(() => tool.parseInput(null)).toThrow(Error);
    expect(() => tool.parseInput([])).toThrow(Error);
  });

  it("reports ISO and local wall-clock values for the injected clock", async () => {
    const result = await createCurrentTimeTool({
      clock: () => fixedEpoch,
      timeZone: "Pacific/Auckland",
      locale: "en-US",
    }).execute({}, context());
    if (!result.ok)
      throw new Error(`expected success, got ${result.error.code}`);
    const value = result.value as {
      iso: string;
      local: string;
      timeZone: string;
      locale: string;
    };
    expect(value.iso).toBe("2026-10-10T06:30:00.000Z");
    expect(value.local).toMatch(/2026/);
    expect(value.local).toContain("Saturday");
    expect(value.local).toContain(":");
    expect(value.timeZone).toBe("Pacific/Auckland");
    expect(value.locale).toBe("en-US");
  });

  it("fails recoverably when the configured time zone is unavailable", async () => {
    const result = await createCurrentTimeTool({
      clock: () => fixedEpoch,
      timeZone: "Not/AZone",
      locale: "en-US",
    }).execute({}, context());
    expect(result).toMatchObject({ ok: false, error: { code: "malformed" } });
  });

  it("reports canceled when the invocation signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createCurrentTimeTool({
      clock: () => fixedEpoch,
    }).execute({}, context(controller.signal));
    expect(result).toMatchObject({ ok: false, error: { code: "canceled" } });
  });
});
