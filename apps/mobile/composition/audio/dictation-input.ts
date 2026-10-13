import { createSpeechSystemInput } from "@locallab/speech-system";
import { speechSystemNative } from "@locallab/speech-system/expo";

/** Native dictation input; Metro resolves the .web stub in browsers. */
export const dictationInput = createSpeechSystemInput(speechSystemNative);
