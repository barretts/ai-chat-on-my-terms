import { describe, expect, it } from "vitest";
import { markdownCopyPayload, parseMarkdown } from "./markdown";

describe("native rich transcript Markdown", () => {
  it("preserves underscores inside code identifiers while rendering separate emphasis", () => {
    const source =
      "FINAL_RETRY_ANCHOR and field__name, plus _italic_ and __bold__.";
    const block = parseMarkdown(source)[0];
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") throw new Error("Expected a paragraph");
    expect(block.value.map((node) => node.value).join("")).toBe(
      "FINAL_RETRY_ANCHOR and field__name, plus italic and bold.",
    );
    expect(block.value).toContainEqual({
      type: "text",
      value: "italic",
      marks: ["italic"],
    });
    expect(block.value).toContainEqual({
      type: "text",
      value: "bold",
      marks: ["bold"],
    });
    expect(markdownCopyPayload(source)).toBe(source);
  });
  it("preserves numbered list starts when model output separates items with blank lines", () => {
    const blocks = parseMarkdown("1. First\n\n2. Second\n\n3. Third");
    expect(
      blocks.map((block) => (block.type === "list" ? block.start : undefined)),
    ).toEqual([1, 2, 3]);
  });
  it("parses common blocks and inline math without evaluating source", () => {
    const blocks = parseMarkdown(
      "# Answer\n\nUse **bold** and `code`; $x^2$\n\n```ts\nconst n = 2;\n```\n\n$$\na + b = c\n$$",
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "code",
      "math",
    ]);
    const paragraph = blocks[1];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type === "paragraph") {
      expect(paragraph.value).toContainEqual({ type: "math", value: "x^2" });
      expect(paragraph.value).toContainEqual({
        type: "text",
        value: "bold",
        marks: ["bold"],
      });
    }
    expect(blocks[2]).toMatchObject({
      type: "code",
      language: "ts",
      value: "const n = 2;",
    });
    expect(blocks[3]).toMatchObject({ type: "math", value: "a + b = c" });
  });

  it("keeps raw HTML inert, renders link labels without navigation, and copies source", () => {
    const source = "<script>no-op</script>\n[link](https://example.test)";
    expect(parseMarkdown(source)).toEqual([
      {
        type: "paragraph",
        value: [
          { type: "text", value: "<script>no-op</script>\n" },
          { type: "text", value: "link" },
        ],
      },
    ]);
    expect(markdownCopyPayload(source)).toBe(source);
  });
});
