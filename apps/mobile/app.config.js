// Expo loads this after app.json. Store builds must never embed developer access.
module.exports = ({ config }) => {
  const storeBuild =
    process.env.APP_STORE_BUILD === "1" ||
    process.env.EAS_BUILD_PROFILE === "production";
  if (storeBuild) {
    const developerVariables = Object.keys(process.env).filter(
      (key) =>
        (key.startsWith("EXPO_PUBLIC_STRATA_") ||
          key.startsWith("EXPO_PUBLIC_DEV_")) &&
        process.env[key]?.trim(),
    );
    if (developerVariables.length > 0) {
      throw new Error(
        `Remove developer defaults from the App Store build environment: ${developerVariables.join(", ")}`,
      );
    }
  }
  if (!storeBuild) {
    // The EAS-managed ad-hoc provisioning profile predates the memory
    // capabilities, so device/preview builds sign without them; store builds
    // keep the declared pair (build 23 proof).
    const { entitlements, ...ios } = config.ios ?? {};
    config.ios = ios;
  }
  return config;
};
