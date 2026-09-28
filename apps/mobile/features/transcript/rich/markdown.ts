export type InlineNode =
  | { type: "text"; value: string; marks?: Array<"bold" | "italic" | "code"> }
  | { type: "math"; value: string };

export type MarkdownBlock =
  | { type: "paragraph" | "heading"; value: InlineNode[]; level?: number }
  | { type: "code"; value: string; language?: string }
  | { type: "math"; value: string }
  | { type: "quote"; value: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][]; start?: number };

function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern =
    /\$\$([\s\S]+?)\$\$|\$([^\n$]+)\$|`([^`]+)`|\[([^\]]+)\]\(([^)]*)\)|\*\*([\s\S]+?)\*\*|(^|[^_\p{L}\p{N}])__([\s\S]+?)__(?![_\p{L}\p{N}])|\*([^*\n]+)\*|(^|[^_\p{L}\p{N}])_([^_\n]+)_(?![_\p{L}\p{N}])/gu;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    // Underscores within identifiers are literal characters, not emphasis.
    // The underscore branches consume a boundary; keep it as ordinary text.
    const boundary = match[7] ?? match[10] ?? "";
    const start = (match.index ?? 0) + boundary.length;
    if (start > offset)
      nodes.push({ type: "text", value: source.slice(offset, start) });
    if (match[1] !== undefined) nodes.push({ type: "math", value: match[1] });
    else if (match[2] !== undefined)
      nodes.push({ type: "math", value: match[2] });
    else if (match[3] !== undefined)
      nodes.push({ type: "text", value: match[3], marks: ["code"] });
    else if (match[4] !== undefined)
      nodes.push({ type: "text", value: match[4] });
    else if (match[6] !== undefined || match[8] !== undefined)
      nodes.push({
        type: "text",
        value: match[6] ?? match[8] ?? "",
        marks: ["bold"],
      });
    else
      nodes.push({
        type: "text",
        value: match[9] ?? match[11] ?? "",
        marks: ["italic"],
      });
    offset = (match.index ?? 0) + match[0].length;
  }
  if (offset < source.length)
    nodes.push({ type: "text", value: source.slice(offset) });
  return nodes;
}

/** Safe native subset: links display their label without opening a URL; HTML stays inert text. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      blocks.push({
        type: "paragraph",
        value: parseInline(paragraph.join("\n")),
      });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? ""))
        code.push(lines[i] ?? "");
      blocks.push({
        type: "code",
        value: code.join("\n"),
        ...(fence[1] ? { language: fence[1] } : {}),
      });
    } else if (/^\s*\$\$\s*$/.test(line)) {
      flush();
      const math: string[] = [];
      while (++i < lines.length && !/^\s*\$\$\s*$/.test(lines[i] ?? ""))
        math.push(lines[i] ?? "");
      blocks.push({ type: "math", value: math.join("\n") });
    } else if (!line.trim()) flush();
    else {
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      const quote = line.match(/^\s*>\s?(.*)$/);
      const list = line.match(/^\s*(?:[-*+]\s+|(\d+)\.\s+)(.*)$/);
      if (heading) {
        flush();
        blocks.push({
          type: "heading",
          level: heading[1]?.length ?? 1,
          value: parseInline(heading[2] ?? ""),
        });
      } else if (quote) {
        flush();
        blocks.push({ type: "quote", value: parseInline(quote[1] ?? "") });
      } else if (list) {
        flush();
        const ordered = list[1] !== undefined;
        const items = [parseInline(list[2] ?? "")];
        while (i + 1 < lines.length) {
          const next = (lines[i + 1] ?? "").match(
            /^\s*(?:[-*+]\s+|(\d+)\.\s+)(.*)$/,
          );
          if (!next || (next[1] !== undefined) !== ordered) break;
          i += 1;
          items.push(parseInline(next[2] ?? ""));
        }
        const start = Number(list[1]);
        blocks.push({
          type: "list",
          ordered,
          items,
          ...(ordered
            ? { start: Number.isSafeInteger(start) ? start : 1 }
            : {}),
        });
      } else paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

export function markdownCopyPayload(markdown: string): string {
  return markdown;
}
