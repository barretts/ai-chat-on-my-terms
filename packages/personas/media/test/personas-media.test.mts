import assert from "node:assert/strict";
import test from "node:test";
import {
  PERSONA_MEDIA_SETTINGS_KEY,
  readPersonaMediaSettings,
} from "@locallab/personas-bindings";
import {
  personaMediaPatch,
  resolvePersonaMediaBinding,
  type PersonaWorkflowRegistration,
} from "../src/index.ts";

const workflows: Record<string, PersonaWorkflowRegistration> = {
  "cyberpunk-pack": { name: "cyberpunk-pack", definition: { ckpt: "cy.safetensors" } },
  "comfy-default": { name: "comfy-default", definition: {} },
};

const find = (id: string) => workflows[id];

test("persona-bound workflow wins and the first bound id is used", async () => {
  const profile = {
    [PERSONA_MEDIA_SETTINGS_KEY]: { workflowIds: ["cyberpunk-pack"] },
  };
  const resolved = await resolvePersonaMediaBinding(profile, find);
  assert.equal(resolved.status, "bound");
  assert.equal(resolved.workflow?.name, "cyberpunk-pack");
});

test("unbound personas resolve unbound so callers can use the global setting", async () => {
  const resolved = await resolvePersonaMediaBinding({}, find);
  assert.equal(resolved.status, "unbound");
  assert.equal(resolved.workflow, undefined);
});

test("a removed workflow reports missing with an honest message", async () => {
  const profile = {
    [PERSONA_MEDIA_SETTINGS_KEY]: { workflowIds: ["deleted-pack"] },
  };
  const resolved = await resolvePersonaMediaBinding(profile, find);
  assert.equal(resolved.status, "missing");
  assert.equal(resolved.workflow, undefined, "nothing is substituted");
  assert.match(resolved.message ?? "", /no other workflow was used/i);
});

test("patches round-trip through the profile map; null clears", () => {
  const patch = personaMediaPatch("cyberpunk-pack");
  const settings = readPersonaMediaSettings({ ...patch });
  assert.deepEqual(settings.workflowIds, ["cyberpunk-pack"]);
  const cleared = readPersonaMediaSettings({ ...personaMediaPatch(null) });
  assert.deepEqual(cleared.workflowIds, []);
  assert.throws(() => personaMediaPatch("   "), /non-empty name/);
});
