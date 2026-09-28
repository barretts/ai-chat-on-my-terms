import { describe, expect, it, vi } from "vitest";
import { normalizeComposerDraft, submitComposerDraft } from "./index";

describe("basic composer send intent", () => {
  it("rejects blank drafts and trims text before sending", async () => {
    const send = vi.fn(async () => undefined);
    expect(normalizeComposerDraft("  \n ")).toBe("");
    expect(await submitComposerDraft("  hello  ", send)).toBe(true);
    expect(await submitComposerDraft(" \n", send)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("hello");
  });

  it("propagates a rejected attempt so the UI can preserve the draft", async () => {
    const failure = new Error("offline");
    const send = vi.fn(async () => {
      throw failure;
    });
    await expect(submitComposerDraft("retry me", send)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledWith("retry me");
  });
});
