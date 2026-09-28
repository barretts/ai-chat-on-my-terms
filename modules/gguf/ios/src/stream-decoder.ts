/** Fields llama.rn 0.12.4 attaches to token callbacks and the final result. */
export type LlamaOutput = {
  token?: string;
  text?: string;
  content?: string;
  reasoning_content?: string;
  accumulated_text?: string;
};

export type StreamDeltas = { reasoning: string; text: string };

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * Splits `<think>` blocks out of a cumulative snapshot. While streaming, a
 * trailing partial tag is held back so emitted text never has to be retracted.
 */
export function splitThinking(
  snapshot: string,
  partial: boolean,
): StreamDeltas {
  let reasoning = "";
  let text = "";
  let rest = snapshot;
  while (rest) {
    const open = rest.indexOf(OPEN);
    if (open === -1) {
      text += partial ? withoutPartialTag(rest, OPEN) : rest;
      break;
    }
    text += rest.slice(0, open);
    rest = rest.slice(open + OPEN.length);
    const close = rest.indexOf(CLOSE);
    if (close === -1) {
      reasoning += partial ? withoutPartialTag(rest, CLOSE) : rest;
      break;
    }
    reasoning += rest.slice(0, close);
    rest = rest.slice(close + CLOSE.length);
  }
  return { reasoning: reasoning.trimStart(), text: text.trimStart() };
}

function withoutPartialTag(value: string, tag: string): string {
  for (
    let length = Math.min(tag.length - 1, value.length);
    length > 0;
    length--
  )
    if (value.endsWith(tag.slice(0, length))) return value.slice(0, -length);
  return value;
}

/**
 * llama.rn re-parses the whole output on every token, so `content` and
 * `reasoning_content` are cumulative snapshots; only `token` is a delta.
 * This turns either shape into append-only reasoning/text deltas.
 */
export function createLlamaStreamDecoder() {
  let raw = "";
  let parsedSeen = false;
  let emitted: StreamDeltas = { reasoning: "", text: "" };

  const diff = (next: StreamDeltas): StreamDeltas => {
    const delta = {
      reasoning: suffix(emitted.reasoning, next.reasoning),
      text: suffix(emitted.text, next.text),
    };
    emitted = {
      reasoning: emitted.reasoning + delta.reasoning,
      text: emitted.text + delta.text,
    };
    return delta;
  };

  const snapshot = (output: LlamaOutput, partial: boolean): StreamDeltas => {
    const split = splitThinking(output.content ?? "", partial);
    return {
      reasoning: (output.reasoning_content ?? "").trimStart() + split.reasoning,
      text: split.text,
    };
  };

  const hasParsed = (output: LlamaOutput) =>
    output.content !== undefined ||
    output.reasoning_content !== undefined ||
    output.accumulated_text !== undefined;

  return {
    push(update: LlamaOutput): StreamDeltas {
      if (hasParsed(update)) {
        parsedSeen = true;
        return diff(snapshot(update, true));
      }
      // Updates without parsed fields are native parse failures; after a parsed
      // snapshot the raw token would double-count text already in `content`.
      if (parsedSeen) return { reasoning: "", text: "" };
      raw += update.token ?? "";
      return diff(snapshot({ content: raw }, true));
    },
    finish(result: LlamaOutput): StreamDeltas {
      return diff(
        hasParsed(result)
          ? snapshot(result, false)
          : snapshot({ content: result.text ?? raw }, false),
      );
    },
  };
}

/** Appends only when the snapshot extends what was already emitted. */
function suffix(emitted: string, next: string): string {
  return next.startsWith(emitted) ? next.slice(emitted.length) : "";
}
