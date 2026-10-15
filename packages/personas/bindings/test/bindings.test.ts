import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingOptions,
  personaModelPatch,
  readPersonaMediaSettings,
  readPersonaModelSettings,
  resolvePersonaModelBinding,
} from "../src/index.js";

const CONNECTION = "0195c000-0000-7000-8000-0000000000a1";

test("model settings read identity IDs and drop junk", () => {
  assert.deepEqual(readPersonaModelSettings({ model: { connectionId: CONNECTION } }), {
    connectionId: CONNECTION,
  });
  assert.deepEqual(readPersonaModelSettings(undefined), {});
  assert.deepEqual(readPersonaModelSettings({ model: "openai" }), {});
  // Display names are never bindings.
  assert.deepEqual(
    readPersonaModelSettings({ model: { connectionId: "GPT labeled Fast" } }),
    {},
  );
  assert.deepEqual(readPersonaModelSettings({ model: { connectionId: 7 } }), {});
});

test("patch binds identity and unbinds with an explicit null", () => {
  const patch = personaModelPatch(CONNECTION);
  assert.deepEqual(readPersonaModelSettings(patch), {
    connectionId: CONNECTION,
  });
  assert.deepEqual(personaModelPatch(null), { model: null });
  assert.throws(() => personaModelPatch("Friendly Name"));
});

test("binding resolves the registration without substitution", async () => {
  const registration = { id: CONNECTION, modelId: "llama-3.3-70b" };
  const profile = { model: { connectionId: CONNECTION } };
  const bound = await resolvePersonaModelBinding(profile, () => registration);
  assert.equal(bound.status, "bound");
  assert.equal(bound.registration, registration);
  const unbound = await resolvePersonaModelBinding({}, () => registration);
  assert.equal(unbound.status, "unbound");
  assert.equal(unbound.registration, undefined);
});

test("removed binding is reported and never replaced", async () => {
  const profile = { model: { connectionId: CONNECTION } };
  const missing = await resolvePersonaModelBinding(profile, () => undefined);
  assert.equal(missing.status, "missing");
  assert.equal(missing.registration, undefined);
  assert.match(missing.message ?? "", /removed from Connections/);
  assert.match(missing.message ?? "", /no other model was used/);
});

test("media references survive junk but stay opaque", () => {
  assert.deepEqual(
    readPersonaMediaSettings({ media: { workflowIds: ["wf-portrait", "", 7] } }),
    { workflowIds: ["wf-portrait"] },
  );
  assert.deepEqual(readPersonaMediaSettings({ media: "portrait" }), {
    workflowIds: [],
  });
  assert.deepEqual(readPersonaMediaSettings(undefined), { workflowIds: [] });
});

test("option lists keep a removed binding visible", () => {
  const options = [
    { id: "0195c000-0000-7000-8000-0000000000a1", label: "Lab — llama" },
  ];
  assert.deepEqual(bindingOptions(options, options[0]!.id), [
    { value: options[0]!.id, label: "Lab — llama" },
  ]);
  const removed = bindingOptions(options, "0195c000-0000-7000-8000-0000000000ff");
  assert.equal(removed.length, 2);
  assert.match(removed[0]!.label, /Removed binding/);
  assert.equal(removed[0]!.value, "0195c000-0000-7000-8000-0000000000ff");
  assert.deepEqual(bindingOptions(options, undefined), [
    { value: options[0]!.id, label: "Lab — llama" },
  ]);
});
