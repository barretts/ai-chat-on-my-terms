import { expect, it } from "vitest";
import {
  speechLanguages,
  speechModel,
  speechModels,
  speechVoice,
  speechVoices,
} from "./catalog";

it("keeps every voice bound to an installable model", () => {
  const ids = new Set(speechModels.map((model) => model.id));
  for (const voice of speechVoices) {
    expect(ids.has(voice.modelId), voice.id).toBe(true);
    expect(speechVoice(voice.id).modelId).toBe(voice.modelId);
  }
  expect(new Set(speechVoices.map((voice) => voice.id)).size).toBe(
    speechVoices.length,
  );
  expect(new Set(speechModels.map((model) => model.directory)).size).toBe(
    speechModels.length,
  );
});

it("offers each supported language as an individually downloadable pack", () => {
  const byTag = new Map(speechLanguages.map((item) => [item.tag, item.label]));
  expect([...byTag.keys()].sort()).toEqual([
    "de-DE",
    "en-US",
    "es-ES",
    "fr-FR",
    "ru-RU",
  ]);
  expect(byTag.get("de-DE")).toBe("German");
  expect(byTag.get("ru-RU")).toBe("Russian");
  expect(byTag.get("es-ES")).toBe("Spanish");
  expect(byTag.get("fr-FR")).toBe("French");
  for (const language of byTag.keys()) {
    const models = speechModels.filter(
      (model) => model.language === language,
    );
    expect(models.length, language).toBeGreaterThan(0);
    for (const model of models)
      expect(
        speechVoices.some(
          (voice) => voice.modelId === model.id && voice.language === language,
        ),
        model.id,
      ).toBe(true);
  }
});

it("pins release archives with hashable metadata", () => {
  for (const model of speechModels) {
    expect(model.archiveUrl.endsWith(`${model.directory}.tar.bz2`)).toBe(true);
    expect(model.modelFile.endsWith(".onnx")).toBe(true);
    expect(model.archiveSha256).toMatch(/^[\da-f]{64}$/);
    expect(Number.isSafeInteger(model.archiveBytes)).toBe(true);
    expect(model.archiveBytes).toBeGreaterThan(1_000_000);
    expect(model.license.length).toBeGreaterThan(0);
    expect(model.licenseUrl.startsWith("https://")).toBe(true);
  }
});

it("rejects unknown voices and models", () => {
  expect(() => speechVoice("nope")).toThrow(
    "Choose an available offline voice.",
  );
  expect(() => speechModel("nope")).toThrow(
    "Choose an available offline speech model.",
  );
});
