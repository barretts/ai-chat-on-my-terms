import { useSyncExternalStore } from "react";

function currentScheme(): "light" | "dark" {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function subscribe(listener: () => void) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** Browser preference changes need a live media-query subscription. */
export function useSystemColorScheme() {
  return useSyncExternalStore(subscribe, currentScheme, () => "light");
}
