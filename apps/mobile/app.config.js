// Expo loads this after app.json. Store builds must never embed developer access.
module.exports = ({ config }) => {
  const storeBuild =
    process.env.APP_STORE_BUILD === "1" ||
    process.env.EAS_BUILD_PROFILE === "production";
  if (storeBuild) {
    const developerVariables = Object.keys(process.env).filter(
      (key) =>
        key.startsWith("EXPO_PUBLIC_STRATA_") && process.env[key]?.trim(),
    );
    if (developerVariables.length > 0) {
      throw new Error(
        `Remove developer defaults from the App Store build environment: ${developerVariables.join(", ")}`,
      );
    }
  }
  return config;
};
