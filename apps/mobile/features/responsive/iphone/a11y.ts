/**
 * T119 — iPhone accessibility declarations (UI-18, UI-17): VoiceOver
 * labels for every navigation key in all six locales, status meaning
 * that never rides on color alone, and WCAG contrast audit over the
 * theme color pairs.
 */
import {
  LOCALES,
  UI_STRING_KEYS,
  contrastRatio,
  translate,
  type Locale,
  type UiStringKey,
} from "@locallab/localization";

export interface VoiceOverLabel {
  key: UiStringKey;
  label: string;
}

/** VoiceOver routing needs a non-empty label for every control; an
 * empty one silently blocks navigation. */
export function voiceOverLabels(locale: Locale): VoiceOverLabel[] {
  return UI_STRING_KEYS.map((key) => ({ key, label: translate(locale, key) }));
}

export type AppStatus = "ready" | "downloading" | "offline";

const STATUS_KEYS = {
  ready: "status.model_ready",
  downloading: "status.model_downloading",
  offline: "status.offline",
} as const satisfies Record<AppStatus, UiStringKey>;

const STATUS_COLORS = {
  ready: "success",
  downloading: "accent",
  offline: "muted",
} as const satisfies Record<AppStatus, string>;

export interface StatusIndicator {
  colorToken: string;
  text: string;
}

/** UI-18: state is color AND text in every locale — never color
 * alone. */
export function statusIndicator(status: AppStatus, locale: Locale): StatusIndicator {
  return { colorToken: STATUS_COLORS[status], text: translate(locale, STATUS_KEYS[status]) };
}

export interface ThemePair {
  name: string;
  textHex: string;
  backgroundHex: string;
  /** Large-text/UI-element pairs may use the 3:1 floor. */
  large?: boolean;
}

/** UI-18 audit: pairs failing their WCAG floor are reported. */
export function contrastFailures(pairs: readonly ThemePair[]): string[] {
  return pairs
    .filter(
      (p) => contrastRatio(p.textHex, p.backgroundHex) < (p.large === true ? 3 : 4.5),
    )
    .map((p) => p.name);
}

export { LOCALES };
