/** iOS alternate app icons: default / dark / glass (project-owned art). */
export type AppIconName = "default" | "dark" | "glass";

export const APP_ICON_NAMES: readonly AppIconName[] = [
  "default",
  "dark",
  "glass",
];

/** The native bridge iOS exposes for alternate icons. `null` icon name =
 * the primary (default) icon. */
export interface AppIconBridge {
  canSetAlternateIcons(): boolean;
  currentIconName(): Promise<string | null>;
  setAlternateIconName(name: string | null): Promise<void>;
}

export type AppIconResult =
  | { ok: true; icon: AppIconName }
  | { ok: false; reason: string };

export interface AppIconController {
  isEligible(): boolean;
  current(): Promise<AppIconName>;
  select(icon: AppIconName): Promise<AppIconResult>;
}

export function createAppIconController(bridge: AppIconBridge): AppIconController {
  return {
    isEligible() {
      return bridge.canSetAlternateIcons();
    },
    async current() {
      const name = await bridge.currentIconName();
      if (name === null) return "default";
      return isAppIconName(name) ? name : "default";
    },
    async select(icon) {
      if (!isAppIconName(icon))
        return { ok: false, reason: `"${String(icon)}" is not a bundled icon` };
      if (!bridge.canSetAlternateIcons())
        return {
          ok: false,
          reason: "this device cannot switch app icons",
        };
      try {
        await bridge.setAlternateIconName(icon === "default" ? null : icon);
        return { ok: true, icon };
      } catch {
        return {
          ok: false,
          reason: "the icon switch was refused; try again later",
        };
      }
    },
  };
}

function isAppIconName(value: string): value is AppIconName {
  return (APP_ICON_NAMES as readonly string[]).includes(value);
}
