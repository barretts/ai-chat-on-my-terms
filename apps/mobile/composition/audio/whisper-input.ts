import { whisperTranscription } from "../../platform/whisper";
import { createWhisperInputPort } from "./whisper-input-port";

export { createWhisperInputPort } from "./whisper-input-port";

/** App-wide local Whisper dictation port bound to the platform singleton. */
export const whisperInputPort = createWhisperInputPort(whisperTranscription);
