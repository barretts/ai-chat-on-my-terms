import { describe, expect, it } from "vitest";
import {
  enabledLmStudioIntegrationRefs,
  isLmStudioIntegrationName,
  normalizeLmStudioIntegrationName,
  supportsLmStudioIntegratedMcp,
  translateLmStudioIntegrationError,
  type LmStudioIntegration,
} from "../src/index.js";

const row = (
  name: string,
  enabled = true,
  id = `row-${name}`,
  label = name,
): LmStudioIntegration => ({ id, name, label, enabled });

describe("LM Studio integrated names", () => {
  it("canonicalizes mcp.json server names into plugin references", () => {
    expect(normalizeLmStudioIntegrationName("playwright")).toBe(
      "mcp/playwright",
    );
    expect(normalizeLmStudioIntegrationName("  mcp/playwright ")).toBe(
      "mcp/playwright",
    );
    expect(normalizeLmStudioIntegrationName("mcp/filesystem_v2.1")).toBe(
      "mcp/filesystem_v2.1",
    );
  });

  it("rejects names that are not integrated server names", () => {
    for (const bad of [
      "",
      "   ",
      "https://example.com/mcp",
      "http://127.0.0.1:1234",
      "mcp/../etc",
      "mcp/a b",
      "mcp/",
      "mcp//x",
      "mcp/" + "x".repeat(90),
      "not mcp/x",
      "mcp/x/y",
    ])
      expect(normalizeLmStudioIntegrationName(bad), bad).toBeUndefined();
    expect(isLmStudioIntegrationName("playwright")).toBe(false);
    expect(isLmStudioIntegrationName("mcp/playwright")).toBe(true);
  });

  it("collects only enabled integrations, deduplicated, in order", () => {
    expect(
      enabledLmStudioIntegrationRefs([
        row("mcp/playwright"),
        row("mcp/other", false),
        row("mcp/playwright"),
        row("bogus"),
        row("mcp/last"),
      ]),
    ).toEqual(["mcp/playwright", "mcp/last"]);
    expect(enabledLmStudioIntegrationRefs([])).toEqual([]);
  });

  it("is true only for lmstudio kinds", () => {
    expect(supportsLmStudioIntegratedMcp("lmstudio")).toBe(true);
    for (const kind of [
      "ollama",
      "compatible",
      "jan",
      "omlx",
      "unsloth",
      "openai",
      "cloud-compatible",
    ])
      expect(supportsLmStudioIntegratedMcp(kind), kind).toBe(false);
  });

  it("explains missing integrations with the reported name", () => {
    const failure = translateLmStudioIntegrationError(
      "Plugin mcp/playwright was not found",
    );
    expect(failure?.message).toContain("mcp/playwright");
    expect(failure?.recovery).toContain("mcp.json");
    const quoted = translateLmStudioIntegrationError(
      "integration with id 'filesystem' is not available",
    );
    expect(quoted?.message).toContain("mcp/filesystem");
  });

  it("explains blocked mcp.json access and unavailable servers", () => {
    expect(
      translateLmStudioIntegrationError(
        "Calling servers from mcp.json is not allowed by server settings",
      )?.recovery,
    ).toContain("Allow calling servers from mcp.json");
    expect(
      translateLmStudioIntegrationError(
        "failed to start mcp server mcp/playwright: process exited",
      )?.message,
    ).toContain("unavailable");
  });

  it("passes unrelated failures through untouched", () => {
    for (const unrelated of [
      "context length exceeded",
      "model is loading",
      "401 Unauthorized",
      "stream ended without chat.end",
    ])
      expect(translateLmStudioIntegrationError(unrelated)).toBeUndefined();
  });
});
