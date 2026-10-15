import { createSystemSpeechOutput } from "@locallab/speech-system";
import { speechSystemOutputNative } from "@locallab/speech-system/expo";

/** Native system voice output; Metro resolves the .web stub in browsers. */
export const systemSpeechOutput = createSystemSpeechOutput(
  speechSystemOutputNative,
);
