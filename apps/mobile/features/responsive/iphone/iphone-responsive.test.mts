import { describe, expect, it } from "vitest";
import {
  MIN_TOUCH_TARGET_PT,
  columnCount,
  focusOrderViolations,
  isLandscape,
  scaledFontSize,
  touchTargetViolations,
} from "./layout.ts";
import { LOCALES, contrastFailures, statusIndicator, voiceOverLabels } from "./a11y.ts";

describe("iPhone landscape two-column layout (UI-10)", () => {
  it("portrait is one column, landscape two", () => {
    expect(columnCount({ widthPt: 390, heightPt: 844 })).toBe(1);
    expect(isLandscape({ widthPt: 390, heightPt: 844 })).toBe(false);
    expect(columnCount({ widthPt: 844, heightPt: 390 })).toBe(2);
    expect(columnCount({ widthPt: 667, heightPt: 375 })).toBe(2);
  });

  it("dynamic type scales but clamps so navigation never blocks", () => {
    expect(scaledFontSize(17, 1)).toBe(17);
    expect(scaledFontSize(17, 1.5)).toBe(25.5);
    expect(scaledFontSize(17, 12)).toBe(34); // clamped at 2x
    expect(scaledFontSize(17, Number.NaN)).toBe(17);
    expect(scaledFontSize(17, 0.5)).toBe(17); // never below system default
  });
});

describe("native audit: touch targets and focus order (T119 step 3)", () => {
  it("flags controls under the 44pt floor", () => {
    expect(MIN_TOUCH_TARGET_PT).toBe(44);
    expect(
      touchTargetViolations([
        { id: "send", widthPt: 44, heightPt: 44 },
        { id: "mic", widthPt: 43, heightPt: 44 },
        { id: "swipe", widthPt: 60, heightPt: 28 },
      ]),
    ).toEqual(["mic", "swipe"]);
  });

  it("flags broken keyboard/focus traversal", () => {
    expect(
      focusOrderViolations([
        { id: "input", tabIndex: 1 },
        { id: "send", tabIndex: 2 },
        { id: "menu", tabIndex: 3 },
      ]),
    ).toEqual([]);
    expect(
      focusOrderViolations([
        { id: "input", tabIndex: 2 },
        { id: "send", tabIndex: 2 },
        { id: "back", tabIndex: 1 },
      ]),
    ).toEqual(["send", "back"]);
  });
});

describe("VoiceOver + non-color status + contrast (UI-18, UI-17)", () => {
  it("every navigation key has a VoiceOver label in all six locales", () => {
    for (const locale of LOCALES) {
      const labels = voiceOverLabels(locale);
      expect(labels.length).toBeGreaterThan(0);
      for (const entry of labels) expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("status meaning never rides on color alone", () => {
    for (const locale of LOCALES) {
      for (const status of ["ready", "downloading", "offline"] as const) {
        const indicator = statusIndicator(status, locale);
        expect(indicator.colorToken).toBeTruthy();
        expect(indicator.text.length).toBeGreaterThan(0);
      }
    }
    expect(statusIndicator("offline", "zh").text).toBe("离线");
  });

  it("theme contrast audit enforces WCAG floors", () => {
    expect(
      contrastFailures([
        { name: "body", textHex: "#1c1c1e", backgroundHex: "#ffffff" },
        { name: "muted", textHex: "#767676", backgroundHex: "#ffffff" },
        { name: "accent-large", textHex: "#8a8a8e", backgroundHex: "#ffffff", large: true },
      ]),
    ).toEqual([]);
    expect(
      contrastFailures([
        { name: "too-light", textHex: "#aaaaaa", backgroundHex: "#ffffff" },
      ]),
    ).toEqual(["too-light"]);
  });
});
