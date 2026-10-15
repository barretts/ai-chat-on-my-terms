import { describe, expect, it } from "vitest";
import type { ProviderPort } from "@locallab/contracts/ports";
import type { RunEvent } from "@locallab/contracts/run-events";
import {
  BUNDLED_PERSONA_PALETTES,
  GeneratedPersonaSchema,
  ProviderPersonaGenerator,
  bundledAppearance,
} from "../src/index";

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const now = new Date().toISOString();

function stream(
  runId: string,
  deltas: readonly string[],
  terminal: "RunCompleted" | "RunFailed" | "RunCanceled" = "RunCompleted",
): RunEvent[] {
  const events: RunEvent[] = [];
  let sequence = 0;
  for (const delta of deltas)
    events.push({
      runId,
      sequence: sequence++,
      timestamp: now,
      type: "TextDelta",
      text: delta,
    } as RunEvent);
  events.push({
    runId,
    sequence: sequence++,
    timestamp: now,
    type: terminal,
  } as RunEvent);
  return events;
}

interface FakePort {
  port: ProviderPort;
  requests: { modelId: string; system: string }[];
  cleanups(): number;
}

function fakePort(
  reply: (attempt: number, runId: string) => RunEvent[],
): FakePort {
  const requests: { modelId: string; system: string }[] = [];
  let attempts = 0;
  let closed = 0;
  const port: ProviderPort = {
    listModels: async () => ({ ok: true, value: ["test-persona-model"] }),
    getCapabilities: async () => ({ ok: true, value: {} }),
    startRun(request) {
      attempts += 1;
      const system = request.context.find((entry) => entry.kind === "system");
      requests.push({
        modelId: request.modelId,
        system: system?.kind === "system" ? String(system.value) : "",
      });
      return (async function* () {
        try {
          for (const event of reply(attempts, request.runId)) yield event;
        } finally {
          closed += 1;
        }
      })();
    },
  };
  return { port, requests, cleanups: () => closed };
}

function generator(port: ProviderPort): ProviderPersonaGenerator {
  let runs = 0;
  return new ProviderPersonaGenerator({
    port,
    providerConnectionId: uuid(0x158),
    modelId: "test-persona-model",
    createId: () => uuid(0x700 + runs++),
  });
}

const GOOD = JSON.stringify({
  name: " Harbor ",
  description: " A friendly port guide. ",
  prompt:
    "You are Harbor. Answer maritime questions warmly, keep replies practical, and ask one clarifying question when the route is unclear.",
});

describe("ProviderPersonaGenerator", () => {
  it("returns a trimmed validated draft for a well-formed reply", async () => {
    const fake = fakePort((_attempt, runId) => stream(runId, [GOOD]));
    const result = await generator(fake.port).generate({
      idea: "a harbor guide",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("generated");
    if (result.status !== "generated") return;
    expect(result.persona.name).toBe("Harbor");
    expect(result.persona.description).toBe("A friendly port guide.");
    expect(result.persona.prompt.length).toBeGreaterThanOrEqual(20);
  });

  it("recovers fenced JSON on the first attempt", async () => {
    const fake = fakePort((_attempt, runId) =>
      stream(runId, ["```json\n", GOOD, "\n```"]),
    );
    const result = await generator(fake.port).generate({
      idea: "harbor",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("generated");
    expect(fake.requests.length).toBe(1);
  });

  it("retries once with the rejected excerpt, then succeeds", async () => {
    const fake = fakePort((attempt, runId) =>
      attempt === 1
        ? stream(runId, ["sorry, here is prose instead"])
        : stream(runId, [GOOD]),
    );
    const result = await generator(fake.port).generate({
      idea: "harbor guide",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("generated");
    expect(fake.requests.length).toBe(2);
    expect(fake.requests[1]!.system).toContain("Rejected reply excerpt");
  });

  it("fails after the bounded attempts when replies stay malformed", async () => {
    const fake = fakePort((attempt, runId) =>
      stream(runId, [
        "not json",
        attempt === 2 ? " still not json" : "",
      ]),
    );
    const result = await generator(fake.port).generate({
      idea: "harbor",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("failed");
    expect(fake.requests.length).toBe(2);
  });

  it("maps provider failure to a failed result without retry", async () => {
    const fake = fakePort((_attempt, runId) => stream(runId, [], "RunFailed"));
    const result = await generator(fake.port).generate({
      idea: "harbor",
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      status: "failed",
      message: "The selected model could not generate the Persona.",
    });
    expect(fake.requests.length).toBe(1);
  });

  it("maps a provider cancellation event to a canceled result", async () => {
    const fake = fakePort((_attempt, runId) =>
      stream(runId, ["partial"], "RunCanceled"),
    );
    const result = await generator(fake.port).generate({
      idea: "harbor",
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ status: "canceled" });
  });

  it("reports cancellation when the caller signal aborts mid-stream", async () => {
    const caller = new AbortController();
    const port: ProviderPort = {
      listModels: async () => ({ ok: true, value: ["test-persona-model"] }),
      getCapabilities: async () => ({ ok: true, value: {} }),
      startRun(request) {
        return (async function* () {
          yield {
            runId: request.runId,
            sequence: 0,
            timestamp: now,
            type: "TextDelta",
            text: "partial",
          } as RunEvent;
          // Abort deterministically from inside the consumed stream.
          caller.abort();
          await new Promise<never>(() => {});
        })();
      },
    };
    const result = await generator(port).generate({
      idea: "harbor",
      signal: caller.signal,
    });
    expect(result.status).toBe("canceled");
  });

  it("aborts cleanly and closes the stream when already canceled", async () => {
    const caller = new AbortController();
    caller.abort();
    const fake = fakePort((_attempt, runId) => stream(runId, [GOOD]));
    await expect(
      generator(fake.port).generate({
        idea: "harbor",
        signal: caller.signal,
      }),
    ).rejects.toThrow();
    expect(fake.requests.length).toBe(0);
  });

  it("keeps malformed profiles from enabling memory sharing", () => {
    const shared = GeneratedPersonaSchema.safeParse({
      name: "Harbor",
      description: "",
      prompt: "You are Harbor. Answer kindly about ships and routes please.",
      memorySharing: true,
    });
    expect(shared.success).toBe(false);
  });

  it("rejects an empty idea before calling the provider", async () => {
    const fake = fakePort((_attempt, runId) => stream(runId, [GOOD]));
    const result = await generator(fake.port).generate({
      idea: "   ",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("failed");
    expect(fake.requests.length).toBe(0);
  });
});

describe("bundledAppearance", () => {
  it("is deterministic and owned by the project palette", () => {
    const first = bundledAppearance("Harbor");
    const second = bundledAppearance("Harbor");
    expect(first).toEqual(second);
    expect(BUNDLED_PERSONA_PALETTES).toContainEqual({
      accentColor: first.accentColor,
      backgroundColor: first.backgroundColor,
    });
    expect(["circle", "square"]).toContain(first.avatarShape);
    expect(bundledAppearance("Marina")).not.toEqual(first);
  });
});
