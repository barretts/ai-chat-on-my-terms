const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

function useSceneLifecycle(source) {
  if (
    source.includes(
      "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider",
    )
  ) {
    return source;
  }
  const declaration = "class AppDelegate: ExpoAppDelegate {";
  const launch =
    /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?launchOptions: launchOptions\)\n#endif/;
  if (!source.includes(declaration) || !launch.test(source)) {
    throw new Error(
      "The Expo AppDelegate template changed; review scene lifecycle integration before building.",
    );
  }
  return source
    .replace(
      declaration,
      "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {",
    )
    .replace(
      launch,
      "// ExpoAppSceneDelegate creates the window and starts React Native for its scene.",
    );
}

module.exports = function withIOSScenes(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "EXExpoAppSceneDelegate",
          },
        ],
      },
    };
    return mod;
  });
  return withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== "swift") {
      throw new Error(
        "Scene lifecycle integration requires the Expo Swift AppDelegate.",
      );
    }
    mod.modResults.contents = useSceneLifecycle(mod.modResults.contents);
    return mod;
  });
};
module.exports.useSceneLifecycle = useSceneLifecycle;
