import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILTIN_THEMES,
  BUILTIN_THEME_IDS,
  clampControls,
  isHexColor,
  parseOverrideImport,
  parseThemeImport,
  resolveAppearance,
  THEMES_SCHEMA_VERSION,
} from "../src/index.js";
import type { AppearanceOverrideV1, ThemeV1 } from "../src/index.js";

const VALID_IMPORT = {
  version: 1,
  id: "my-theme",
  name: "My Theme",
  kind: "custom",
  scheme: "light",
  palette: {
    background: "#ffffff",
    surface: "#f0f0f0",
    primary: "#59328b",
    text: "#111111",
  },
  controls: {
    fontScale: 1.2,
    bubbleStyle: "rounded",
    gradient: { from: "#ff0000", to: "#00ff00", angleDegrees: 45 },
    backgroundDim: 0.3,
    avatarSize: "large",
    avatarPlacement: "trailing",
    fontChoice: "serif",
  },
};

function requireTheme(raw: unknown): ThemeV1 {
  const parsed = parseThemeImport(raw);
  if (!parsed.ok) throw new Error(`expected import to pass: ${parsed.reason}`);
  return parsed.theme;
}

function requireReason(raw: unknown): string {
  const parsed = parseThemeImport(raw);
  if (parsed.ok) throw new Error("expected import to fail");
  return parsed.reason;
}

test("built-in themes match declared ids and have distinct palettes", () => {
  assert.deepEqual(
    BUILTIN_THEMES.map((theme) => theme.id),
    [...BUILTIN_THEMES, BUILTIN_THEME_IDS].slice(0, 0).concat([...BUILTIN_THEME_IDS]),
  );
  const palettes = new Set(
    BUILTIN_THEMES.map((theme) => JSON.stringify(theme.palette)),
  );
  assert.equal(palettes.size, BUILTIN_THEMES.length);
  for (const theme of BUILTIN_THEMES) {
    assert.equal(theme.version, THEMES_SCHEMA_VERSION);
    assert.equal(theme.kind, "builtin");
    assert.ok(theme.name.length >= 1 && theme.name.length <= 48);
  }
});

test("built-in theme sets carry complete light and dark variants", () => {
  assert.ok(BUILTIN_THEMES.length >= 2);
  for (const theme of BUILTIN_THEMES) {
    const variants = theme.variants;
    assert.ok(variants !== undefined, `${theme.id} should carry variants`);
    for (const palette of [variants.light, variants.dark]) {
      for (const key of ["background", "surface", "primary", "text"] as const)
        assert.ok(isHexColor(palette[key]), `${theme.id}.${key}`);
    }
    assert.deepEqual(theme.palette, variants.light);
  }
});

test("theme import preserves variants and rejects malformed variant palettes", () => {
  const variants = {
    light: {
      background: "#ffffff",
      surface: "#f0f0f0",
      primary: "#59328b",
      text: "#111111",
    },
    dark: {
      background: "#0f1c38",
      surface: "#16294c",
      primary: "#a8c7fa",
      text: "#e7eefb",
    },
  };
  const theme = requireTheme({ ...VALID_IMPORT, variants });
  assert.deepEqual(theme.variants, variants);
  const roundTrip = parseThemeImport(theme);
  assert.ok(roundTrip.ok);
  assert.deepEqual(roundTrip.ok ? roundTrip.theme.variants : null, variants);

  const badVariant = {
    ...VALID_IMPORT,
    variants: { ...variants, dark: { ...variants.dark, primary: "nope" } },
  };
  assert.ok(requireReason(badVariant).includes("variants"));

  const extraKey = {
    ...VALID_IMPORT,
    variants: {
      ...variants,
      light: { ...variants.light, accent: "#123456" },
    },
  };
  assert.ok(!parseThemeImport(extraKey).ok);
});

test("valid import round-trips and kind is forced custom", () => {
  const theme = requireTheme(VALID_IMPORT);
  assert.deepEqual(theme, VALID_IMPORT);
  assert.equal(requireTheme(theme.id !== undefined ? VALID_IMPORT : VALID_IMPORT).id, "my-theme");

  const asBuiltin = { ...VALID_IMPORT, kind: "builtin" };
  assert.equal(requireTheme(asBuiltin).kind, "custom");

  const reparsed = parseThemeImport(theme);
  assert.ok(reparsed.ok);
});

test("parsed theme typeflows as ThemeV1", () => {
  const parsed = parseThemeImport(VALID_IMPORT);
  if (!parsed.ok) throw new Error(`expected import to pass: ${parsed.reason}`);
  const theme: ThemeV1 = parsed.theme;
  assert.equal(theme.version, 1);
});

test("missing or non-1 version is rejected mentioning version", () => {
  const { version: _version, ...noVersion } = VALID_IMPORT;
  assert.match(requireReason(noVersion), /version/);
  assert.match(requireReason({ ...VALID_IMPORT, version: 0 }), /version/);
  assert.match(requireReason({ ...VALID_IMPORT, version: "1" }), /version/);
});

test("unknown top-level and controls keys are rejected", () => {
  assert.match(requireReason({ ...VALID_IMPORT, extra: true }), /extra/);
  assert.match(
    requireReason({ ...VALID_IMPORT, controls: { ...VALID_IMPORT.controls, hue: 1 } }),
    /hue/,
  );
});

test("bad hex colors are rejected naming the field", () => {
  assert.match(requireReason({ ...VALID_IMPORT, palette: { ...VALID_IMPORT.palette, surface: "#GGG" } }), /surface/);
  assert.match(
    requireReason({ ...VALID_IMPORT, palette: { ...VALID_IMPORT.palette, primary: "#AABBCC" } }),
    /primary/,
  );
  assert.match(
    requireReason({
      ...VALID_IMPORT,
      controls: { ...VALID_IMPORT.controls, gradient: { from: "#fff", to: "#00ff00", angleDegrees: 10 } },
    }),
    /gradient/,
  );
});

test("out-of-range numbers are rejected in imports, not clamped", () => {
  assert.match(requireReason({ ...VALID_IMPORT, controls: { ...VALID_IMPORT.controls, fontScale: 99 } }), /fontScale/);
  assert.match(requireReason({ ...VALID_IMPORT, controls: { ...VALID_IMPORT.controls, fontScale: 0.5 } }), /fontScale/);
  assert.match(requireReason({ ...VALID_IMPORT, controls: { ...VALID_IMPORT.controls, backgroundDim: 5 } }), /backgroundDim/);
  assert.match(
    requireReason({
      ...VALID_IMPORT,
      controls: { ...VALID_IMPORT.controls, gradient: { from: "#ff0000", to: "#00ff00", angleDegrees: 360 } },
    }),
    /angleDegrees/,
  );
  assert.match(
    requireReason({
      ...VALID_IMPORT,
      controls: { ...VALID_IMPORT.controls, gradient: { from: "#ff0000", to: "#00ff00", angleDegrees: 45.5 } },
    }),
    /angleDegrees/,
  );
});

test("id and name constraints are enforced", () => {
  assert.ok(requireReason({ ...VALID_IMPORT, id: "My_Theme" }).includes("id"));
  assert.ok(requireReason({ ...VALID_IMPORT, id: "-x" }).includes("id"));
  assert.ok(requireReason({ ...VALID_IMPORT, name: "" }).includes("name"));
  assert.ok(requireReason({ ...VALID_IMPORT, name: "x".repeat(49) }).includes("name"));
});

test("isHexColor only accepts lowercase #rrggbb", () => {
  assert.ok(isHexColor("#59328b"));
  assert.ok(!isHexColor("#AABBCC"));
  assert.ok(!isHexColor("#abc"));
  assert.ok(!isHexColor("59328b"));
});

test("clampControls fills defaults and clamps numbers", () => {
  assert.equal(clampControls({ fontScale: 99 }).fontScale, 2.0);
  assert.equal(clampControls({ fontScale: -1 }).fontScale, 0.8);
  assert.equal(clampControls({ backgroundDim: 5 }).backgroundDim, 0.6);
  assert.equal(clampControls({}).fontScale, 1);
  assert.equal(clampControls({}).backgroundDim, 0);
  assert.equal(clampControls({}).bubbleStyle, "classic");
  assert.equal(clampControls({}).gradient, null);
  assert.equal(clampControls({ gradient: { from: "#000000", to: "#ffffff", angleDegrees: 400 } })!.gradient!.angleDegrees, 359);
});

test("resolveAppearance with unknown themeId keeps the given theme", () => {
  const builtin = BUILTIN_THEMES[0]!;
  const resolved = resolveAppearance(builtin, { version: 1, themeId: "nope" }, BUILTIN_THEMES);
  assert.equal(resolved.theme, builtin);
});

test("resolveAppearance with null override returns identical controls", () => {
  const dark = BUILTIN_THEMES.find((theme) => theme.id === "slate")!;
  const resolved = resolveAppearance(dark, null, BUILTIN_THEMES);
  assert.equal(resolved.theme, dark);
  assert.deepEqual(resolved.controls, dark.controls);
});

test("resolveAppearance applies known themeId and clamped override fields", () => {
  const builtin = BUILTIN_THEMES[0]!;
  const custom: ThemeV1 = requireTheme(VALID_IMPORT);
  const themed = resolveAppearance(builtin, { version: 1, themeId: "my-theme" }, [...BUILTIN_THEMES, custom]);
  assert.equal(themed.theme.id, "my-theme");

  const overridden = resolveAppearance(builtin, { version: 1, fontScale: 99, fontChoice: "mono" }, BUILTIN_THEMES);
  assert.equal(overridden.theme, builtin);
  assert.equal(overridden.controls.fontScale, 2.0);
  assert.equal(overridden.controls.fontChoice, "mono");
});

test("parseOverrideImport never throws on garbage and validates real payloads", () => {
  const garbage: unknown[] = [
    null,
    undefined,
    0,
    "",
    "override",
    [],
    {},
    { version: 0 },
    { version: 1, bogus: 1 },
    { version: 1, fontScale: "big" },
    { version: 1, themeId: 123 },
    { version: 1, gradient: { from: "white", to: "#00ff00", angleDegrees: 10 } },
  ];
  for (const raw of garbage) {
    const parsed = parseOverrideImport(raw);
    assert.equal(typeof parsed.ok, "boolean");
    if (!parsed.ok) {
      assert.ok(parsed.reason.length > 0);
      continue;
    }
    assert.equal(parsed.override.version, 1);
  }

  const parsed = parseOverrideImport({ version: 1, themeId: "dark", fontScale: 1.5, gradient: null });
  if (!parsed.ok) throw new Error(`expected override import to pass: ${parsed.reason}`);
  const override: AppearanceOverrideV1 = parsed.override;
  assert.equal(override.themeId, "dark");
  assert.equal(override.fontScale, 1.5);
  assert.equal(override.gradient, null);
});
