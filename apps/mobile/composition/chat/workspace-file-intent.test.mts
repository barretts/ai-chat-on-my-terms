import { describe, expect, it } from "vitest";
import {
  requestsWorkspaceTools,
  workspaceDocumentInstruction,
  workspaceFileIntent,
} from "./workspace-file-intent";

describe("explicit file writing intent", () => {
  it.each([
    ["Write notes/plan.md about the launch.", "notes/plan.md"],
    ["Can you please create `notes/plan.md`?", "notes/plan.md"],
    ['Please save this as "notes/plan.txt".', "notes/plan.txt"],
    [
      "I want you to update ‘notes/Plan.md’ with the new details.",
      "notes/Plan.md",
    ],
    ["I'd like you to revise 'notes/plan.md'.", "notes/plan.md"],
    ["Please make a Markdown file about gardening.", "notes.md"],
    ["Create a plain text document with a checklist.", "notes.txt"],
    ["Write an example to examples/guide.md.", "examples/guide.md"],
    ["Check web and write the results to report.md.", "report.md"],
    [
      "Search the web, then save a Markdown file called sources.md.",
      "sources.md",
    ],
    [
      "Summarize the findings and then create `notes/research.md`.",
      "notes/research.md",
    ],
    [
      "Here is the topic. Then write a text file called notes.txt.",
      "notes.txt",
    ],
    [
      "Write notes.md with the literal string `save wrong.txt` in it.",
      "notes.md",
    ],
    ["~~~text\ncreate example.md\n~~~\nPlease write real.md.", "real.md"],
    [
      "````md\n```txt\nwrite example.txt\n```\n````\nSave real.txt.",
      "real.txt",
    ],
  ])("recognizes a direct request %j", (text, path) => {
    expect(workspaceFileIntent(text)).toEqual({ path });
    expect(requestsWorkspaceTools(text)).toBe(true);
  });

  it.each([
    "Explain how to save notes.md.",
    "How do I create a Markdown file?",
    "Can you show me how to write notes.md?",
    "Write code showing how to save notes.md.",
    "Write an example using notes.md.",
    "Explain how to read a file and write notes.md.",
    "Can you show me how to fetch data and then create notes.md?",
    'What does "save notes.md" mean?',
    "Explain 'write notes.md'.",
    "`write notes.md`",
    "Print `create notes.md` in an example.",
    "```md\nWrite notes.md\n```\nExplain that instruction.",
    "~~~text\nSave notes.md\n~~~\nExplain this example.",
    "> Create notes.md\nSummarize the quote.",
    "Do not save a Markdown file.",
    "Please don't write notes.md.",
    "Never create notes.txt.",
    "Write notes.md but do not save it.",
    "Fetch https://example.com/write/notes.md and explain it.",
    "Tell me about Markdown files.",
  ])(
    "leaves procedure questions, examples and negated commands as ordinary chat %j",
    (text) => {
      expect(workspaceFileIntent(text)).toBeUndefined();
      expect(requestsWorkspaceTools(text)).toBe(false);
    },
  );

  it.each([
    "List the saved files.",
    "Please show my workspace files.",
    "Read `notes/plan.md`.",
    "Can you open notes.txt?",
    "What files are saved?",
    "Which files are in this chat?",
  ])("enables file read/list tools for a direct request %j", (text) => {
    expect(workspaceFileIntent(text)).toBeUndefined();
    expect(requestsWorkspaceTools(text)).toBe(true);
  });

  it("uses complete-document instructions for text models and confirmed tool writes for native tools", () => {
    expect(
      workspaceDocumentInstruction({ path: "notes/plan.md" }, false),
    ).toContain("complete document contents");
    expect(
      workspaceDocumentInstruction({ path: "notes/plan.md" }, false),
    ).toContain("internal code fences");
    expect(
      workspaceDocumentInstruction({ path: "notes/plan.md" }, true),
    ).toContain("expectedRevision");
    expect(
      workspaceDocumentInstruction({ path: "notes/plan.md" }, true),
    ).toContain("tool succeeded");
  });
});
