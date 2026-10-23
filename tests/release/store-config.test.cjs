const assert = require("node:assert/strict");
const { test } = require("node:test");
const configure = require("../../apps/mobile/app.config.js");
const eas = require("../../apps/mobile/eas.json");

test("store profile uses store signing without preview defaults", () => {
  const profile = eas.build.production;
  assert.equal(profile.distribution, "store");
  assert.equal(profile.developmentClient, false);
  assert.equal(profile.autoIncrement, true);
  assert.equal(profile.env.APP_STORE_BUILD, "1");
  assert.equal(profile.extends, undefined);
  assert.equal(profile.ios.image, "macos-tahoe-26.6-xcode-27.1");
});

test("store config rejects injected developer credentials and endpoints", () => {
  const before = { ...process.env };
  try {
    process.env.APP_STORE_BUILD = "1";
    for (const suffix of ["API_KEY", "BASE_URL", "MODEL_ID"]) {
      const key = `EXPO_PUBLIC_STRATA_${suffix}`;
      process.env[key] = "fixture-value";
      assert.throws(
        () => configure({ config: {} }),
        /Remove developer defaults/,
      );
      delete process.env[key];
    }
    const config = { name: "AI Chat on My Terms" };
    assert.equal(configure({ config }), config);
    delete process.env.APP_STORE_BUILD;
    process.env.EAS_BUILD_PROFILE = "production";
    process.env.EXPO_PUBLIC_STRATA_API_KEY = "fixture-value";
    assert.throws(() => configure({ config }), /Remove developer defaults/);
    process.env.EAS_BUILD_PROFILE = "preview";
    assert.equal(configure({ config }), config);
  } finally {
    process.env = before;
  }
});

test("local-model entitlements are visible before native prebuild", () => {
  const { expo } = require("../../apps/mobile/app.json");
  for (const capability of [
    "extended-virtual-addressing",
    "increased-memory-limit",
  ]) {
    assert.equal(
      expo.ios.entitlements[`com.apple.developer.kernel.${capability}`],
      true,
    );
  }
});

test("iPhone rotation excludes upside-down; iPad preserves multitasking", () => {
  const { expo } = require("../../apps/mobile/app.json");
  assert.equal(expo.orientation, "default");
  assert.equal(expo.ios.supportsTablet, true);
  const orientations = [
    "UIInterfaceOrientationPortrait",
    "UIInterfaceOrientationLandscapeLeft",
    "UIInterfaceOrientationLandscapeRight",
  ];
  for (const key of [
    "UISupportedInterfaceOrientations",
    "UISupportedInterfaceOrientations~ipad",
  ]) {
    assert.deepEqual(
      expo.ios.infoPlist[key],
      key.endsWith("~ipad")
        ? [
            orientations[0],
            "UIInterfaceOrientationPortraitUpsideDown",
            ...orientations.slice(1),
          ]
        : orientations,
    );
  }
});
