import { expect, it } from "vitest";
import type { SecretRef, SecretStore } from "@locallab/security-secrets";
import { saveOpenAIEndpointSetup } from "./index";

const ref = "sec_00000000-0000-4000-8000-000000000001" as SecretRef;
const previousRef = "sec_00000000-0000-4000-8000-000000000002" as SecretRef;
const input = {
  connectionId: "00000000-0000-4000-8000-000000000003",
  endpointUrl: "https://api.fixture.example/v1/responses",
  modelId: "fixture-model",
  apiKey: "fixture-key",
};
const cleanupCause = new Error("Fixture secure removal failed");
const secrets: SecretStore = {
  put: async () => ({
    ref,
    host: "https://api.fixture.example",
    headerName: "authorization",
  }),
  resolveHeaders: async () => ({ authorization: "fixture-key" }),
  remove: async () => {
    throw cleanupCause;
  },
};

it("retains save rejection while reporting the failed rollback and reference to retry", async () => {
  const saveCause = new Error("Fixture database write failed");
  const failures: unknown[] = [];
  await expect(
    saveOpenAIEndpointSetup({
      ...input,
      secrets,
      repository: {
        get: async () => null,
        save: async () => {
          throw saveCause;
        },
      },
      onCleanupFailure: (cause, pending, committed) =>
        failures.push({ cause, pending, committed }),
    }),
  ).rejects.toBe(saveCause);
  expect(failures).toEqual([
    { cause: cleanupCause, pending: ref, committed: false },
  ]);
});

it("keeps a committed replacement usable while reporting previous-key removal failure", async () => {
  let saved: unknown;
  const failures: unknown[] = [];
  const result = await saveOpenAIEndpointSetup({
    ...input,
    secrets,
    repository: {
      get: async () => ({ ...input, apiKeyRef: previousRef }),
      save: async (value) => {
        saved = value;
      },
    },
    onCleanupFailure: (cause, pending, committed) =>
      failures.push({ cause, pending, committed }),
  });
  expect(result.apiKeyRef).toBe(ref);
  expect(saved).toEqual(result);
  expect(failures).toEqual([
    { cause: cleanupCause, pending: previousRef, committed: true },
  ]);
});
