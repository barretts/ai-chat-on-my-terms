import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCALES,
  UI_CATALOGS,
  UI_STRING_KEYS,
  contrastRatio,
  isRtl,
  missingKeys,
  overlongLabels,
  resolveLocalePreference,
  translate,
} from "../src/index.ts";

test("six language catalogs complete, no English fallbacks (step 1)", () => {
  assert.deepEqual(LOCALES, ["en", "zh", "es", "fr", "de", "ru"]);
  for (const locale of LOCALES) {
    assert.deepEqual(missingKeys(locale), [], locale);
    for (const key of UI_STRING_KEYS)
      assert.ok(translate(locale, key).length > 0, `${locale}/${key}`);
  }
  assert.equal(translate("zh", "action.send"), "发送");
  assert.equal(translate("ru", "action.new_chat"), "Новый чат");
});

test("follow-system selection; explicit pick wins; unknown falls back (step 1)", () => {
  assert.equal(resolveLocalePreference("zh", "en-US"), "zh");
  assert.equal(resolveLocalePreference(null, "zh-Hans-CN"), "zh");
  assert.equal(resolveLocalePreference(undefined, "fr_CA"), "fr");
  assert.equal(resolveLocalePreference("bogus", "de-DE"), "de");
  // System languages without a catalog fall back to English.
  assert.equal(resolveLocalePreference(null, "ja-JP"), "en");
  assert.equal(resolveLocalePreference(null, ""), "en");
});

test("long-string and RTL audit (step 3)", () => {
  for (const locale of LOCALES)
    assert.deepEqual(overlongLabels(locale), [], locale);
  // None of the six shipped languages mirrors; rule stays wired.
  for (const locale of LOCALES) assert.equal(isRtl(locale), false, locale);
});

test("UI-18 contrast math (WCAG ratio)", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  // AA normal-text gray: 4.54 — passes 4.5, and one step lighter fails.
  assert.ok(contrastRatio("#767676", "#ffffff") >= 4.5);
  assert.ok(contrastRatio("#777777", "#ffffff") < 4.5);
  assert.throws(() => contrastRatio("red", "#ffffff"), /bad color/);
});
