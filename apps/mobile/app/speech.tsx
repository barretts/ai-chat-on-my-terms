import { Redirect } from "expo-router";

export default function SpeechRoute() {
  return <Redirect href={{ pathname: "/chat", params: { panel: "voices" } }} />;
}
