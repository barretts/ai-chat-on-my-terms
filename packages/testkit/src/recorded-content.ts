/** Synthetic, already-sanitized data only. Never populate this fixture from a user trace. */
export const recordedRedactedContent = {
  fixture: "synthetic-chat-v1",
  request: {
    authorization: "[REDACTED]",
    prompt: "[REDACTED]",
    model: "fixture-model",
  },
  response: {
    text: "[REDACTED]",
    finishReason: "stop",
  },
  redactions: ["authorization", "prompt", "response.text"],
} as const;
