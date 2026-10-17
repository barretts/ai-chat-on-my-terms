import { z } from "zod";

export const THEMES_SCHEMA_VERSION = 1;

export type ThemeScheme = "light" | "dark";
export type BubbleStyle = "classic" | "rounded" | "sharp";
export type FontChoice = "system" | "serif" | "mono";
export type AvatarSize = "small" | "medium" | "large";
export type AvatarPlacement = "leading" | "trailing" | "hidden";

export interface PaletteV1 {
  background: string;
  surface: string;
  primary: string;
  text: string;
}

/** Light and dark palettes for a single theme set. */
export interface ThemeVariantsV1 {
  light: PaletteV1;
  dark: PaletteV1;
}

export interface GradientV1 {
  from: string;
  to: string;
  angleDegrees: number;
}

export interface ThemeControlsV1 {
  fontScale: number;
  bubbleStyle: BubbleStyle;
  gradient: GradientV1 | null;
  backgroundDim: number;
  avatarSize: AvatarSize;
  avatarPlacement: AvatarPlacement;
  fontChoice: FontChoice;
}

export interface ThemeV1 {
  version: 1;
  id: string;
  name: string;
  kind: "builtin" | "custom";
  scheme: ThemeScheme;
  palette: PaletteV1;
  /** When present, this theme repaints both schemes; palette mirrors the light one. */
  variants?: ThemeVariantsV1;
  controls: ThemeControlsV1;
}

export interface AppearanceOverrideV1 {
  version: 1;
  themeId?: string;
  fontScale?: number;
  bubbleStyle?: BubbleStyle;
  gradient?: GradientV1 | null;
  backgroundDim?: number;
  avatarSize?: AvatarSize;
  avatarPlacement?: AvatarPlacement;
  fontChoice?: FontChoice;
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

const FONT_SCALE_MIN = 0.8;
const FONT_SCALE_MAX = 2.0;
const BACKGROUND_DIM_MIN = 0;
const BACKGROUND_DIM_MAX = 0.6;

const DEFAULT_CONTROLS: ThemeControlsV1 = {
  fontScale: 1,
  bubbleStyle: "classic",
  gradient: null,
  backgroundDim: 0,
  avatarSize: "medium",
  avatarPlacement: "leading",
  fontChoice: "system",
};

const BUBBLE_STYLES: Record<string, true> = { classic: true, rounded: true, sharp: true };
const FONT_CHOICES: Record<string, true> = { system: true, serif: true, mono: true };
const AVATAR_SIZES: Record<string, true> = { small: true, medium: true, large: true };
const AVATAR_PLACEMENTS: Record<string, true> = {
  leading: true,
  trailing: true,
  hidden: true,
};

export const BUILTIN_THEME_IDS = [
  "builtin",
  "teal",
  "amber",
  "forest",
  "rose",
  "slate",
] as const;

export const BUILTIN_THEMES: readonly ThemeV1[] = [
  {
    version: THEMES_SCHEMA_VERSION,
    id: "builtin",
    name: "Locallab Default",
    kind: "builtin",
    scheme: "light",
    palette: {
      background: "#f8f9fb",
      surface: "#ffffff",
      primary: "#2f5fa8",
      text: "#20232b",
    },
    variants: {
      light: {
        background: "#f8f9fb",
        surface: "#ffffff",
        primary: "#2f5fa8",
        text: "#20232b",
      },
      dark: {
        background: "#0f1c38",
        surface: "#16294c",
        primary: "#a8c7fa",
        text: "#e7eefb",
      },
    },
    controls: { ...DEFAULT_CONTROLS },
  },
  {
    version: THEMES_SCHEMA_VERSION,
    id: "teal",
    name: "Harbor Teal",
    kind: "builtin",
    scheme: "light",
    palette: {
      background: "#f4faf9",
      surface: "#ffffff",
      primary: "#0f6b6e",
      text: "#17252a",
    },
    variants: {
      light: {
        background: "#f4faf9",
        surface: "#ffffff",
        primary: "#0f6b6e",
        text: "#17252a",
      },
      dark: {
        background: "#08201f",
        surface: "#103331",
        primary: "#7fd4d2",
        text: "#dff0ee",
      },
    },
    controls: { ...DEFAULT_CONTROLS },
  },
  {
    version: THEMES_SCHEMA_VERSION,
    id: "amber",
    name: "Amber Sepia",
    kind: "builtin",
    scheme: "light",
    palette: {
      background: "#fdf7ec",
      surface: "#fffdf8",
      primary: "#96601c",
      text: "#2b2116",
    },
    variants: {
      light: {
        background: "#fdf7ec",
        surface: "#fffdf8",
        primary: "#96601c",
        text: "#2b2116",
      },
      dark: {
        background: "#221708",
        surface: "#36280f",
        primary: "#e5b96b",
        text: "#f5e9d6",
      },
    },
    controls: { ...DEFAULT_CONTROLS },
  },
  {
    version: THEMES_SCHEMA_VERSION,
    id: "forest",
    name: "Forest Trail",
    kind: "builtin",
    scheme: "light",
    palette: {
      background: "#f3f8f2",
      surface: "#ffffff",
      primary: "#2f6b3d",
      text: "#1b241d",
    },
    variants: {
      light: {
        background: "#f3f8f2",
        surface: "#ffffff",
        primary: "#2f6b3d",
        text: "#1b241d",
      },
      dark: {
        background: "#0c1d11",
        surface: "#14301d",
        primary: "#8ed49c",
        text: "#e0f2e3",
      },
    },
    controls: { ...DEFAULT_CONTROLS },
  },
  {
    version: THEMES_SCHEMA_VERSION,
    id: "rose",
    name: "Sunset Rose",
    kind: "builtin",
    scheme: "light",
    palette: {
      background: "#fdf4f3",
      surface: "#ffffff",
      primary: "#a4424e",
      text: "#291a1c",
    },
    variants: {
      light: {
        background: "#fdf4f3",
        surface: "#ffffff",
        primary: "#a4424e",
        text: "#291a1c",
      },
      dark: {
        background: "#261014",
        surface: "#3d1e24",
        primary: "#f0a1aa",
        text: "#fbe4e6",
      },
    },
    controls: { ...DEFAULT_CONTROLS },
  },
  {
    version: THEMES_SCHEMA_VERSION,
    id: "slate",
    name: "Slate Mono",
    kind: "builtin",
    scheme: "light",
    palette: {
      background: "#f5f6f7",
      surface: "#ffffff",
      primary: "#47525f",
      text: "#1f242a",
    },
    variants: {
      light: {
        background: "#f5f6f7",
        surface: "#ffffff",
        primary: "#47525f",
        text: "#1f242a",
      },
      dark: {
        background: "#14171c",
        surface: "#21262e",
        primary: "#b7c3d0",
        text: "#e8ecf1",
      },
    },
    controls: { ...DEFAULT_CONTROLS },
  },
];

export function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

const hexColorSchema = z.string().regex(HEX_COLOR_RE);
const fontScaleSchema = z.number().min(FONT_SCALE_MIN).max(FONT_SCALE_MAX);
const backgroundDimSchema = z
  .number()
  .min(BACKGROUND_DIM_MIN)
  .max(BACKGROUND_DIM_MAX);
const angleSchema = z.number().int().min(0).max(359);

const gradientSchema = z
  .object({ from: hexColorSchema, to: hexColorSchema, angleDegrees: angleSchema })
  .strict();

const paletteSchema = z
  .object({
    background: hexColorSchema,
    surface: hexColorSchema,
    primary: hexColorSchema,
    text: hexColorSchema,
  })
  .strict();

const importControlsSchema = z
  .object({
    fontScale: fontScaleSchema,
    bubbleStyle: z.enum(["classic", "rounded", "sharp"]),
    gradient: gradientSchema.nullable(),
    backgroundDim: backgroundDimSchema,
    avatarSize: z.enum(["small", "medium", "large"]),
    avatarPlacement: z.enum(["leading", "trailing", "hidden"]),
    fontChoice: z.enum(["system", "serif", "mono"]),
  })
  .strict();

const themeImportSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(THEME_ID_RE),
    name: z.string().min(1).max(48),
    kind: z.enum(["builtin", "custom"]).optional(),
    scheme: z.enum(["light", "dark"]),
    palette: paletteSchema,
    variants: z
      .object({ light: paletteSchema, dark: paletteSchema })
      .strict()
      .optional(),
    controls: importControlsSchema,
  })
  .strict();

const overrideImportSchema = z
  .object({
    version: z.literal(1),
    themeId: z.string().min(1).max(64).optional(),
    fontScale: fontScaleSchema.optional(),
    bubbleStyle: z.enum(["classic", "rounded", "sharp"]).optional(),
    gradient: gradientSchema.nullable().optional(),
    backgroundDim: backgroundDimSchema.optional(),
    avatarSize: z.enum(["small", "medium", "large"]).optional(),
    avatarPlacement: z.enum(["leading", "trailing", "hidden"]).optional(),
    fontChoice: z.enum(["system", "serif", "mono"]).optional(),
  })
  .strict();

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.join(".") || "(root)";
      const expected = "expected" in issue ? ` (expected ${issue.expected})` : "";
      return `${where}: ${issue.message}${expected}`;
    })
    .join("; ");
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampGradient(gradient: GradientV1 | null): GradientV1 | null {
  if (gradient === null) return null;
  return {
    ...gradient,
    angleDegrees: clampNumber(Math.round(gradient.angleDegrees), 0, 359, 0),
  };
}

function pickEnum<T extends string>(
  value: T | undefined,
  allowed: Record<string, true>,
  fallback: T,
): T {
  return value !== undefined && value in allowed ? value : fallback;
}

function normalizeControls(partial: Partial<ThemeControlsV1>): ThemeControlsV1 {
  return {
    fontScale:
      partial.fontScale === undefined
        ? DEFAULT_CONTROLS.fontScale
        : clampNumber(partial.fontScale, FONT_SCALE_MIN, FONT_SCALE_MAX, 1),
    bubbleStyle: pickEnum(partial.bubbleStyle, BUBBLE_STYLES, DEFAULT_CONTROLS.bubbleStyle),
    gradient:
      partial.gradient === undefined
        ? null
        : clampGradient(partial.gradient),
    backgroundDim:
      partial.backgroundDim === undefined
        ? DEFAULT_CONTROLS.backgroundDim
        : clampNumber(
            partial.backgroundDim,
            BACKGROUND_DIM_MIN,
            BACKGROUND_DIM_MAX,
            0,
          ),
    avatarSize: pickEnum(partial.avatarSize, AVATAR_SIZES, DEFAULT_CONTROLS.avatarSize),
    avatarPlacement: pickEnum(
      partial.avatarPlacement,
      AVATAR_PLACEMENTS,
      DEFAULT_CONTROLS.avatarPlacement,
    ),
    fontChoice: pickEnum(partial.fontChoice, FONT_CHOICES, DEFAULT_CONTROLS.fontChoice),
  };
}

export function clampControls(partial: Partial<ThemeControlsV1>): ThemeControlsV1 {
  return normalizeControls(partial);
}

export function resolveAppearance(
  theme: ThemeV1,
  override: AppearanceOverrideV1 | null,
  allThemes: readonly ThemeV1[],
) {
  let resolvedTheme = theme;
  if (override?.themeId !== undefined) {
    const found = allThemes.find((candidate) => candidate.id === override.themeId);
    if (found !== undefined) resolvedTheme = found;
  }
  const controls = normalizeControls(resolvedTheme.controls);
  if (override === null) return { theme: resolvedTheme, controls };
  return {
    theme: resolvedTheme,
    controls: normalizeControls({
      ...controls,
      ...(override.fontScale !== undefined ? { fontScale: override.fontScale } : {}),
      ...(override.bubbleStyle !== undefined ? { bubbleStyle: override.bubbleStyle } : {}),
      ...(override.gradient !== undefined ? { gradient: override.gradient } : {}),
      ...(override.backgroundDim !== undefined ? { backgroundDim: override.backgroundDim } : {}),
      ...(override.avatarSize !== undefined ? { avatarSize: override.avatarSize } : {}),
      ...(override.avatarPlacement !== undefined
        ? { avatarPlacement: override.avatarPlacement }
        : {}),
      ...(override.fontChoice !== undefined ? { fontChoice: override.fontChoice } : {}),
    }),
  };
}

export function parseThemeImport(
  raw: unknown,
): { ok: true; theme: ThemeV1 } | { ok: false; reason: string } {
  const parsed = themeImportSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, reason: formatIssues(parsed.error) };
  return {
    ok: true as const,
    theme: {
      version: THEMES_SCHEMA_VERSION,
      id: parsed.data.id,
      name: parsed.data.name,
      kind: "custom" as const,
      scheme: parsed.data.scheme,
      palette: parsed.data.palette,
      ...(parsed.data.variants !== undefined
        ? { variants: parsed.data.variants }
        : {}),
      controls: parsed.data.controls,
    },
  };
}

export function parseOverrideImport(
  raw: unknown,
): { ok: true; override: AppearanceOverrideV1 } | { ok: false; reason: string } {
  const parsed = overrideImportSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, reason: formatIssues(parsed.error) };
  const override: AppearanceOverrideV1 = { version: THEMES_SCHEMA_VERSION };
  if (parsed.data.themeId !== undefined) override.themeId = parsed.data.themeId;
  if (parsed.data.fontScale !== undefined) override.fontScale = parsed.data.fontScale;
  if (parsed.data.bubbleStyle !== undefined) override.bubbleStyle = parsed.data.bubbleStyle;
  if (parsed.data.gradient !== undefined) override.gradient = parsed.data.gradient;
  if (parsed.data.backgroundDim !== undefined) override.backgroundDim = parsed.data.backgroundDim;
  if (parsed.data.avatarSize !== undefined) override.avatarSize = parsed.data.avatarSize;
  if (parsed.data.avatarPlacement !== undefined) {
    override.avatarPlacement = parsed.data.avatarPlacement;
  }
  if (parsed.data.fontChoice !== undefined) override.fontChoice = parsed.data.fontChoice;
  return { ok: true as const, override };
}
