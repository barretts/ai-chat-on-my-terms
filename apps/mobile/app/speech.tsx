import { router } from "expo-router";
import { SpeechPanel } from "../features/speech/screen";

export default function SpeechRoute() {
  return <SpeechPanel onClose={() => router.replace("/chat")} />;
}
