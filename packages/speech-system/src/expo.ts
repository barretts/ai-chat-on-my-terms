import { requireNativeModule } from "expo";
import {
  createPcmCapture,
  createSpeechSystemInput,
  createSystemSpeechOutput,
  type NativePcmCaptureModule,
  type NativeSpeechSystem,
  type NativeSystemSpeechOutput,
} from "./index";

/** Native bridge for an Expo development build with SpeechSystem autolinked. */
export const speechSystemNative = requireNativeModule<NativeSpeechSystem>(
  "SpeechSystem",
);

/** Same native module, T072 system-output half (AVSpeechSynthesizer). */
export const speechSystemOutputNative =
  requireNativeModule<NativeSystemSpeechOutput>("SpeechSystem");

/** Same native module, T077 raw PCM capture half (local Whisper input). */
export const speechSystemCaptureNative =
  requireNativeModule<NativePcmCaptureModule>("SpeechSystem");

export { createPcmCapture, createSpeechSystemInput, createSystemSpeechOutput };
