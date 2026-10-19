export const WORKSPACE_FILES_TOOL = "workspace_files";

export interface WorkspaceFileIntent {
  path: string;
}

const filename = /^[A-Za-z0-9_./-]+\.(?:md|txt)$/i;
const namedFile = /(?:^|[\s(])([A-Za-z0-9_./-]+\.(?:md|txt))(?=$|[\s),.!?])/i;
const documentKind =
  /\b(?:(?:markdown|plain\s+text|text|\.md|\.txt)\s+(?:file|document)|file\s+(?:in|as)\s+markdown)\b/i;
const writingVerb = "(?:write|save|create|make|export|update|edit|revise)";
const requestPrefix =
  "(?:(?:please|also|and|then)\\s+)*(?:(?:can|could|will|would)\\s+you\\s+(?:please\\s+)?|I\\s+(?:want|need|would\\s+like)\\s+you\\s+to\\s+|I['’]d\\s+like\\s+you\\s+to\\s+|let['’]s\\s+)?(?:(?:please|also|and|then)\\s+)*";

/** Examples are not instructions; quoted/inline filenames still identify requested files. */
function requestText(text: string): string {
  let fence: { character: string; length: number } | undefined;
  const outsideFences = text
    .split("\n")
    .map((line) => {
      const mark = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          mark &&
          mark[1]![0] === fence.character &&
          mark[1]!.length >= fence.length &&
          !mark[2]!.trim()
        )
          fence = undefined;
        return "";
      }
      if (mark) {
        fence = { character: mark[1]![0]!, length: mark[1]!.length };
        return "";
      }
      return /^[ \t]*>/.test(line) ? "" : line;
    })
    .join("\n");
  const keepFilename = (content: string) =>
    filename.test(content.trim()) ? ` ${content.trim()} ` : " ";
  return outsideFences
    .replace(/(`+)([^\n]*?)\1/g, (_match, _ticks: string, content: string) =>
      keepFilename(content),
    )
    .replace(
      /"([^"\n]*)"|“([^”\n]*)”/g,
      (_match, plain: string | undefined, smart: string | undefined) =>
        keepFilename(plain ?? smart ?? ""),
    )
    .replace(
      /(^|[\s(])'([^'\n]*)'|(^|[\s(])‘([^’\n]*)’/g,
      (
        _match,
        prefix: string | undefined,
        plain: string | undefined,
        smartPrefix: string | undefined,
        smart: string | undefined,
      ) =>
        `${prefix ?? smartPrefix ?? ""}${keepFilename(plain ?? smart ?? "")}`,
    )
    .replace(/https?:\/\/\S+/gi, " ");
}

/** Recognize direct document requests, leaving procedure questions and examples as ordinary chat. */
export function workspaceFileIntent(
  text: string,
): WorkspaceFileIntent | undefined {
  const request = requestText(text);
  if (
    new RegExp(
      `\\b(?:do\\s+not|don't|don’t|dont|never)\\s+${writingVerb}\\b`,
      "i",
    ).test(request)
  )
    return undefined;
  const actions = new RegExp(
    `(^|\\n|[.!?]\\s+|\\b(?:and|then|also)\\s+)\\s*${requestPrefix}(${writingVerb})\\b([^\\n]*)`,
    "gi",
  );
  for (const action of request.matchAll(actions)) {
    if (/\b(?:and|then|also)\s+$/i.test(action[1] ?? "")) {
      const earlierClause =
        request
          .slice(0, action.index)
          .split(/\n|[.!?]\s+/)
          .at(-1) ?? "";
      if (
        /^\s*(?:(?:can|could|will|would)\s+you\s+)?(?:explain\b|(?:show|tell)\s+me\s+how\b|how\b|(?:write|create)\s+(?:an?\s+)?(?:example|sample|code|guide|tutorial)\b)/i.test(
          earlierClause,
        )
      )
        continue;
    }
    const rest = action[3] ?? "";
    const name = namedFile.exec(rest)?.[1];
    // "Write code showing how to save notes.md" describes an example, not a target file.
    const procedural =
      /^\s*(?:how\b|(?:an?\s+)?(?:explanation|example|sample|guide|tutorial|instructions|steps|code)\b)/i.test(
        rest,
      );
    const explicitTarget =
      name &&
      new RegExp(
        `(?:\\b(?:to|into|as|named|called)\\s+|\\b(?:file|document)\\s+)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s),.!?])`,
        "i",
      ).test(rest);
    if (procedural && !explicitTarget) continue;
    if (!name && !documentKind.test(rest)) continue;
    return {
      path:
        name ??
        (/\b(?:plain\s+text|text|\.txt)\s+(?:file|document)\b/i.test(rest)
          ? "notes.txt"
          : "notes.md"),
    };
  }
  return undefined;
}

export function requestsWorkspaceTools(text: string): boolean {
  if (workspaceFileIntent(text)) return true;
  const request = requestText(text);
  const direct = new RegExp(
    `(?:^|\\n|[.!?]\\s+)\\s*${requestPrefix}(?:list|show|read|open)\\b([^\\n]{0,80})`,
    "gi",
  );
  const hasDirectRequest = [...request.matchAll(direct)].some((action) => {
    const rest = action[1] ?? "";
    return (
      !/^\s*(?:me\s+)?(?:how\b|(?:an?\s+)?(?:example|sample|guide|tutorial|instructions|code)\b)/i.test(
        rest,
      ) && /\b(?:files|workspace|[A-Za-z0-9_./-]+\.(?:md|txt))\b/i.test(rest)
    );
  });
  return (
    hasDirectRequest ||
    /^\s*(?:what|which)\s+(?:(?:are|saved|the|my|chat)\s+)*(?:files|workspace)\b/i.test(
      request,
    )
  );
}

export function workspaceDocumentInstruction(
  intent: WorkspaceFileIntent,
  nativeTools: boolean,
): string {
  return nativeTools
    ? `The user asked for a file at ${JSON.stringify(intent.path)} in this chat's workspace. Use workspace_write_file to create it. Read an existing file first and supply its expectedRevision when replacing it. When your tool format uses XML parameters, encode content as a quoted JSON string with escaped newlines and quotes, and encode every less-than character inside that string as \\u003c. This preserves whitespace and literal XML or tool closing tags. Confirm that the tool succeeded before saying the file was saved. Files can be exported by the user from Files.`
    : `The user asked for a file at ${JSON.stringify(intent.path)} in this chat's workspace. Return the complete document contents as your response. The app will save the completed response to that file. Omit conversational introductions, claims that you already saved it, and an outer code fence. Keep Markdown, internal code fences, and Unicode intact.`;
}
