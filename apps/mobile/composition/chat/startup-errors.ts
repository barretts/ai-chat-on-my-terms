export function chatStartupError(cause: unknown, platform: string): string {
  const message =
    cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  if (
    platform === "web" &&
    /NoModificationAllowedError|createSyncAccessHandle.*(?:another|already)|Access Handle.*(?:open|exist)/i.test(
      message,
    )
  )
    return "Another app tab has this browser's chat database open. Close that tab, then try opening chat again.";
  return "Chat storage could not be opened. Try again, or return to setup.";
}
