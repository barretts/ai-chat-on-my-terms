import { requireNativeModule } from "expo-modules-core";
import { createAppleMLProbe, type NativeAppleMLProbe } from "./index.js";

/** Native bridge for an Expo development build with AppleMLProbe autolinked. */
export const AppleMLProbe = createAppleMLProbe(
  requireNativeModule<NativeAppleMLProbe>("AppleMLProbe"),
);
