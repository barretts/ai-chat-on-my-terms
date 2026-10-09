import { Redirect } from "expo-router";

export default function ConnectionsRoute() {
  return (
    <Redirect href={{ pathname: "/chat", params: { panel: "connections" } }} />
  );
}
