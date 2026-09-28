import assert from "node:assert/strict";
import test from "node:test";
import {
  contextReloadIntent,
  resolveParameters,
  useGlobalParameters,
} from "../src/index.js";

const layers = {
  global: {
    explicitlySet: {
      temperature: 0.2,
      reasoning: true,
      topK: 40,
      contextWindow: 4096,
    },
  },
  model: { explicitlySet: { temperature: 0.5, topP: 0.9 } },
  persona: {
    enabled: true,
    explicitlySet: { temperature: 0.7, reasoning: false },
  },
  chat: { explicitlySet: { temperature: 0.8 } },
} as const;

test("resolves all enabled layers in global, model, persona, chat order", () => {
  const result = resolveParameters(layers);
  assert.deepEqual(result.effective, {
    temperature: 0.8,
    reasoning: false,
    topK: 40,
    contextWindow: 4096,
    topP: 0.9,
  });
  assert.deepEqual(result.outbound, result.effective);
});

test("disabled Persona has no effect and false remains an explicit override", () => {
  const disabled = resolveParameters({
    ...layers,
    persona: { ...layers.persona, enabled: false },
  });
  assert.equal(disabled.effective.reasoning, true);
  const falseOverride = resolveParameters({
    global: { explicitlySet: { reasoning: true } },
    chat: { explicitlySet: { reasoning: false } },
  });
  assert.equal(falseOverride.effective.reasoning, false);
  assert.equal(falseOverride.outbound.reasoning, false);
});

test("removing a preset restores the preceding value; unsupported saved fields stay local", () => {
  const withModel = resolveParameters({
    global: { explicitlySet: { temperature: 0.2, topK: 40 } },
    model: { explicitlySet: { temperature: 0.6, topK: 80 } },
  });
  const removed = resolveParameters({
    global: { explicitlySet: { temperature: 0.2, topK: 40 } },
  });
  assert.equal(withModel.effective.temperature, 0.6);
  assert.equal(removed.effective.temperature, 0.2);
  const filtered = resolveParameters(
    {
      global: {
        explicitlySet: { topK: 40, temperature: 0.6, reasoning: false },
      },
    },
    { topK: "no", reasoning: "unknown" },
  );
  assert.deepEqual(filtered.outbound, { temperature: 0.6 });
  assert.equal(filtered.unsupported.topK?.value, 40);
  assert.equal(filtered.unsupported.reasoning?.value, false);
});

test("Use Global removes model preset intent and requests context reload when needed", () => {
  const result = useGlobalParameters({
    global: { explicitlySet: {} },
    model: { explicitlySet: { contextWindow: 8192 } },
  });
  assert.equal(result.modelPreset, undefined);
  assert.equal(result.reloadContext, true);
  assert.equal(
    useGlobalParameters({
      global: { explicitlySet: {} },
      model: { explicitlySet: { temperature: 0.4 } },
    }).reloadContext,
    false,
  );
  assert.equal(
    contextReloadIntent({ contextWindow: 4096 }, { contextWindow: 8192 }),
    true,
  );
  assert.equal(
    contextReloadIntent({ temperature: 0.2 }, { temperature: 0.3 }),
    false,
  );
});
