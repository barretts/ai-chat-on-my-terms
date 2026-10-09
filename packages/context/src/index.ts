export type ContextPolicy = "stop" | "roll" | "cut-middle" | "summarize";
export type ContextRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

export interface ContextPart {
  type: string;
  text?: string;
  invocationId?: string;
  input?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

export interface ContextMessage {
  id: string;
  role: ContextRole;
  parts: readonly ContextPart[];
  runId?: string;
  participantId?: string;
  sourceMessageIds?: readonly string[];
  compacted?: boolean;
}

export interface PackedContext {
  messages: readonly ContextMessage[];
  estimatedInputTokens: number;
  outputReservation: number;
  tokenBudget: number;
  omittedMessageIds: readonly string[];
  compactedMessageIds: readonly string[];
}

export interface PackContextOptions {
  messages: readonly ContextMessage[];
  /** Messages that must survive trimming or compaction, together with instructions. */
  requiredMessageIds?: readonly string[];
  tokenBudget: number;
  reservedOutputTokens: number;
  policy: ContextPolicy;
  countTokens?: (messages: readonly ContextMessage[]) => number;
  summarize?: (
    messages: readonly ContextMessage[],
    signal?: AbortSignal,
  ) => Promise<string>;
  signal?: AbortSignal;
}

export class ContextBudgetError extends Error {
  readonly code = "context-full" as const;

  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

/**
 * Fits a transcript to an input budget while keeping tool calls/results atomic.
 * It returns a projection and never mutates or deletes the persisted source.
 */
export async function packContext(
  options: PackContextOptions,
): Promise<PackedContext> {
  validateBudget(options.tokenBudget, options.reservedOutputTokens);
  const capacity = options.tokenBudget - options.reservedOutputTokens;
  const countTokens = options.countTokens ?? conservativeTokenCount;
  const groups = atomicMessageGroups(options.messages);
  const requiredIds = new Set(options.requiredMessageIds);
  const mandatory = mandatoryGroupIndexes(groups, requiredIds);
  const requiredTokens = countTokens(
    mandatory.flatMap((index) => groups[index]!),
  );
  if (requiredTokens > capacity) {
    throw new ContextBudgetError(
      `Required instructions${requiredIds.size ? " and the current message" : ""} need ${requiredTokens} input tokens, but the input budget is ${capacity} (${options.tokenBudget} context tokens minus ${options.reservedOutputTokens} reserved for the response). Shorten the persona/instructions or message, increase the context window to match your model, or lower the output token limit.`,
    );
  }
  const originalTokens = countTokens(options.messages);
  if (originalTokens <= capacity) {
    return result(options.messages, originalTokens, options, [], []);
  }

  if (options.policy === "stop") {
    throw new ContextBudgetError(
      `Context needs ${originalTokens} input tokens; budget is ${capacity}`,
    );
  }

  if (options.policy === "summarize") {
    return summarizeContext(options, groups, capacity, countTokens);
  }

  const selected =
    options.policy === "roll"
      ? chooseNewest(groups, capacity, countTokens, groups.length, requiredIds)
      : chooseCutMiddle(groups, capacity, countTokens, requiredIds);
  const selectedIds = new Set(selected.flat().map((message) => message.id));
  const messages = selected.flat();
  const omitted = options.messages
    .filter((message) => !selectedIds.has(message.id))
    .map((message) => message.id);
  const estimated = countTokens(messages);
  return result(messages, estimated, options, omitted, []);
}

async function summarizeContext(
  options: PackContextOptions,
  groups: readonly (readonly ContextMessage[])[],
  capacity: number,
  countTokens: (messages: readonly ContextMessage[]) => number,
): Promise<PackedContext> {
  if (!options.summarize) {
    throw new ContextBudgetError("Summarize policy requires a summarizer");
  }
  const totalGroups = groups.length;
  for (
    let retainedGroups = totalGroups - 1;
    retainedGroups >= 0;
    retainedGroups--
  ) {
    if (options.signal?.aborted) {
      throw new DOMException("Context compaction canceled", "AbortError");
    }
    const retained = chooseNewest(
      groups,
      Infinity,
      countTokens,
      retainedGroups,
      new Set(options.requiredMessageIds),
    );
    const retainedIds = new Set(retained.flat().map((message) => message.id));
    const omitted = options.messages.filter(
      (message) => !retainedIds.has(message.id),
    );
    if (omitted.length === 0) continue;

    const summaryText = await options.summarize(omitted, options.signal);
    if (options.signal?.aborted) {
      throw new DOMException("Context compaction canceled", "AbortError");
    }
    const summary: ContextMessage = {
      id: `summary:${omitted.map((message) => message.id).join(",")}`,
      role: "system",
      parts: [{ type: "text", text: summaryText }],
      sourceMessageIds: omitted.flatMap((message) => [
        ...(message.sourceMessageIds ?? []),
        message.id,
      ]),
      compacted: true,
    };
    const candidate = [...retained.flat(), summary];
    candidate.sort(
      (left, right) =>
        options.messages.indexOf(left) - options.messages.indexOf(right),
    );
    if (countTokens(candidate) <= capacity) {
      return result(
        candidate,
        countTokens(candidate),
        options,
        [],
        summary.sourceMessageIds ?? [],
      );
    }
  }
  throw new ContextBudgetError(
    "Summary and retained context do not fit the input token budget",
  );
}

function chooseNewest(
  groups: readonly (readonly ContextMessage[])[],
  capacity: number,
  countTokens: (messages: readonly ContextMessage[]) => number,
  maxGroups = groups.length,
  requiredIds: ReadonlySet<string> = new Set(),
): (readonly ContextMessage[])[] {
  const mandatory = mandatoryGroupIndexes(groups, requiredIds);
  const selected = new Set(mandatory);
  if (countTokens(mandatory.flatMap((index) => groups[index]!)) > capacity) {
    throw new ContextBudgetError(
      "Required instructions and messages exceed the input token budget",
    );
  }
  const targetCount = Math.max(maxGroups, mandatory.length);
  for (
    let index = groups.length - 1;
    index >= 0 && selected.size < targetCount;
    index--
  ) {
    if (selected.has(index)) continue;
    const candidate = [...selected, index]
      .sort((left, right) => left - right)
      .flatMap((groupIndex) => groups[groupIndex]!);
    if (countTokens(candidate) <= capacity) selected.add(index);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => groups[index]!);
}

function chooseCutMiddle(
  groups: readonly (readonly ContextMessage[])[],
  capacity: number,
  countTokens: (messages: readonly ContextMessage[]) => number,
  requiredIds: ReadonlySet<string>,
): (readonly ContextMessage[])[] {
  if (groups.length <= 2)
    return chooseNewest(
      groups,
      capacity,
      countTokens,
      groups.length,
      requiredIds,
    );
  const selected = new Set<number>([
    ...mandatoryGroupIndexes(groups, requiredIds),
    0,
    groups.length - 1,
  ]);
  if (
    countTokens([...selected].flatMap((index) => groups[index]!)) > capacity
  ) {
    return chooseNewest(
      groups,
      capacity,
      countTokens,
      groups.length,
      requiredIds,
    );
  }
  for (let distance = 1; distance < groups.length; distance++) {
    for (const index of [distance, groups.length - 1 - distance]) {
      if (index <= 0 || index >= groups.length - 1 || selected.has(index))
        continue;
      const candidate = [...selected, index].sort((a, b) => a - b);
      if (
        countTokens(candidate.flatMap((groupIndex) => groups[groupIndex]!)) <=
        capacity
      ) {
        selected.add(index);
      }
    }
  }
  return [...selected].sort((a, b) => a - b).map((index) => groups[index]!);
}

function mandatoryGroupIndexes(
  groups: readonly (readonly ContextMessage[])[],
  requiredIds: ReadonlySet<string>,
): number[] {
  return groups.flatMap((group, index) =>
    group.some(
      (message) =>
        message.role === "system" ||
        message.role === "developer" ||
        requiredIds.has(message.id),
    )
      ? [index]
      : [],
  );
}

function atomicMessageGroups(
  messages: readonly ContextMessage[],
): (readonly ContextMessage[])[] {
  const ranges = messages.map((message) => [
    ...message.parts
      .filter((part) => part.type === "tool-call" && part.invocationId)
      .map((part) => part.invocationId!),
  ]);
  const result: (readonly ContextMessage[])[] = [];
  for (let start = 0; start < messages.length; ) {
    let end = start;
    const pending = new Set(ranges[start]);
    while (end + 1 < messages.length && pending.size > 0) {
      end += 1;
      for (const part of messages[end]!.parts) {
        if (part.type === "tool-result" && part.invocationId) {
          pending.delete(part.invocationId);
        }
        if (part.type === "tool-call" && part.invocationId) {
          pending.add(part.invocationId);
        }
      }
    }
    result.push(messages.slice(start, end + 1));
    start = end + 1;
  }
  return result;
}

/**
 * Conservative fallback: roughly four UTF-8 bytes per token plus a fixed
 * multimodal surcharge per non-text part. Production callers should supply the
 * selected model's tokenizer.
 */
export function conservativeTokenCount(
  messages: readonly ContextMessage[],
): number {
  let total = 0;
  for (const message of messages) {
    total += 4;
    for (const part of message.parts) {
      if (part.type === "text" || part.type === "reasoning") {
        const text = typeof part.text === "string" ? part.text : "";
        total += Math.ceil(new TextEncoder().encode(text).byteLength / 4);
      } else {
        total += 256;
      }
    }
  }
  return total;
}

function result(
  messages: readonly ContextMessage[],
  estimatedInputTokens: number,
  options: PackContextOptions,
  omittedMessageIds: readonly string[],
  compactedMessageIds: readonly string[],
): PackedContext {
  return {
    messages: [...messages],
    estimatedInputTokens,
    outputReservation: options.reservedOutputTokens,
    tokenBudget: options.tokenBudget,
    omittedMessageIds: [...omittedMessageIds],
    compactedMessageIds: [...compactedMessageIds],
  };
}

function validateBudget(
  tokenBudget: number,
  reservedOutputTokens: number,
): void {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) {
    throw new RangeError("tokenBudget must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(reservedOutputTokens) ||
    reservedOutputTokens < 0 ||
    reservedOutputTokens >= tokenBudget
  ) {
    throw new RangeError("reservedOutputTokens must fit inside tokenBudget");
  }
}
