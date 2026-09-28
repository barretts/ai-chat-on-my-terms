/** Semantic palette shared by native UI surfaces. */
export const colors = {
  background: "#F7F8FA",
  surface: "#FFFFFF",
  surfaceMuted: "#EFF2F6",
  text: "#17212B",
  textMuted: "#526170",
  textOnAccent: "#FFFFFF",
  accent: "#315CFF",
  accentPressed: "#2448D4",
  border: "#CBD3DC",
  focus: "#315CFF",
  danger: "#B42318",
  success: "#137A4B",
  disabled: "#A7B0BA",
} as const;

/** Base spacing in density-independent points. */
export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Dynamic Type friendly sizes; components should avoid fixed-height text rows. */
export const typography = {
  caption: { fontSize: 12, lineHeight: 18, fontWeight: "400" },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: "600" },
  title: { fontSize: 22, lineHeight: 30, fontWeight: "600" },
  headline: { fontSize: 28, lineHeight: 36, fontWeight: "700" },
} as const;

export type SemanticColor = keyof typeof colors;
export type SpacingToken = keyof typeof spacing;
export type TypographyToken = keyof typeof typography;
