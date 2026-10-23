const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  useSceneLifecycle,
} = require("../../apps/mobile/plugins/with-ios-scenes.cjs");

const template = `class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
  var reactNativeFactory: RCTReactNativeFactory?
  func application() {
    reactNativeFactory = factory
#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
  func openURL() { RCTLinkingManager.application(app, open: url, options: options) }
}`;

test("scene lifecycle owns window creation while preserving factory setup and URL forwarding", () => {
  const source = useSceneLifecycle(template);
  assert.match(
    source,
    /AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider/,
  );
  assert.match(source, /reactNativeFactory = factory/);
  assert.match(source, /return super.application/);
  assert.match(source, /RCTLinkingManager.application/);
  assert.doesNotMatch(source, /UIScreen.main|factory.startReactNative/);
  assert.equal(useSceneLifecycle(source), source);
});

test("an unrecognized native template fails the build instead of retaining a second React root", () => {
  assert.throws(
    () => useSceneLifecycle("class AppDelegate: OtherDelegate {}"),
    /template changed/,
  );
});
