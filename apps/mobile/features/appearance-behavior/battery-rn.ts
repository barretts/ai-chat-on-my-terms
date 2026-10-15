import { NativeEventEmitter, NativeModules } from "react-native";
import { inertBatterySource } from "./index";
import type { BatterySource } from "./index";
import type { BatterySnapshot } from "@locallab/appearance-behavior";

interface RNBatteryInfo {
  batteryLevel: number;
  batteryState: string;
}

interface RNBatteryNativeModule {
  getBatteryInfoAsync(): Promise<RNBatteryInfo>;
}

function snapshot(info: RNBatteryInfo): BatterySnapshot {
  return {
    level: info.batteryLevel / 100,
    charging: info.batteryState === "charging" || info.batteryState === "full",
  };
}

/** Real battery source; returns the inert source when the platform module
 * is absent (web, dev tools, unsupported builds). */
export function reactNativeBatterySource(): BatterySource {
  const battery = (
    NativeModules as unknown as Record<
      string,
      RNBatteryNativeModule | undefined
    >
  ).Battery;
  if (
    battery === undefined ||
    typeof battery.getBatteryInfoAsync !== "function"
  )
    return inertBatterySource;
  return {
    async read() {
      try {
        return snapshot(await battery.getBatteryInfoAsync());
      } catch {
        return null;
      }
    },
    subscribe(onChange) {
      const emitter = new NativeEventEmitter(
        battery as unknown as NonNullable<
          ConstructorParameters<typeof NativeEventEmitter>[0]
        >,
      );
      let info: RNBatteryInfo = { batteryLevel: 0, batteryState: "unknown" };
      const emit = () => onChange(snapshot(info));
      const levelSub = emitter.addListener(
        "batteryLevelDidChange",
        (event: { level: number }) => {
          info = { ...info, batteryLevel: event.level };
          emit();
        },
      );
      const stateSub = emitter.addListener(
        "batteryStateDidChange",
        (event: { batteryState: string }) => {
          info = { ...info, batteryState: event.batteryState };
          emit();
        },
      );
      void battery
        .getBatteryInfoAsync()
        .then((current) => {
          info = current;
        })
        .catch(() => undefined);
      return () => {
        levelSub.remove();
        stateSub.remove();
      };
    },
  };
}
