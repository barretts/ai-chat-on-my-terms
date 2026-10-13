import { requireNativeModule } from "expo";
import {
  createSpeechSystemInput,
  type NativeSpeechSystem,
} from "./index";

/** Native bridge for an Expo development build with SpeechSystem autolinked. */
export const speechSystemNative = requireNativeModule<NativeSpeechSystem>(
  "SpeechSystem",
);
export { createSpeechSystemInput };
