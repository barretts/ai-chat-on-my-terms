import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { openMobileDatabase } from "../../platform/database-open";
import {
  createAppearanceBehaviorStore,
  createBehaviorController,
  inertBatterySource,
  type AppearanceBehaviorStore,
  type BatterySource,
  type BehaviorController,
} from "./index";
import type {
  AppearanceBehaviorV1,
  BatterySnapshot,
  EffectLevel,
  SendPortLike,
} from "@locallab/appearance-behavior";

export interface AppearanceBehaviorContextValue {
  readonly behavior: AppearanceBehaviorV1;
  readonly battery: BatterySnapshot | null;
  readonly active: boolean;
  effects: () => EffectLevel;
  plainStream: () => boolean;
  updateBehavior(behavior: AppearanceBehaviorV1): Promise<void>;
  gateSendPort(inner: SendPortLike): BehaviorGateHandle;
}

export type BehaviorGateHandle = ReturnType<BehaviorController["registerGate"]>;

const AppearanceBehaviorContext =
  createContext<AppearanceBehaviorContextValue | null>(null);

/** Mounts the low-battery profile once for the whole app and keeps sync
 * gates deferred while it is active; recovery flushes deferred sends. */
export function AppearanceBehaviorProvider({
  children,
  batterySource = inertBatterySource,
}: {
  children: ReactNode;
  batterySource?: BatterySource;
}) {
  const controllerRef = useRef<BehaviorController | null>(null);
  const [behavior, setBehavior] = useState<AppearanceBehaviorV1 | null>(null);
  const [battery, setBattery] = useState<BatterySnapshot | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    let mounted = true;
    let controller: BehaviorController | null = null;
    let store: AppearanceBehaviorStore | null = null;
    void openMobileDatabase()
      .then((db) => {
        if (!mounted) return;
        store = createAppearanceBehaviorStore(db);
        return db.execAsync(
          "CREATE TABLE IF NOT EXISTS appearance_behavior (scope TEXT PRIMARY KEY NOT NULL, doc TEXT NOT NULL)",
        );
      })
      .then(async () => {
        if (!mounted || store === null) return;
        controller = createBehaviorController(store, batterySource);
        controllerRef.current = controller;
        await controller.start();
        if (!mounted) return;
        setBehavior(controller.behavior);
        setBattery(controller.battery);
        setActive(controller.active);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      controller?.stop();
      controllerRef.current = null;
    };
  }, [batterySource]);
  const value = useMemo<AppearanceBehaviorContextValue | null>(
    () =>
      behavior === null
        ? null
        : {
            behavior,
            battery,
            active,
            effects: () =>
              controllerRef.current?.effects() ??
              (active ? "reduced" : behavior.glassEnabled ? "glass" : "plain"),
            plainStream: () => controllerRef.current?.plainStream() ?? active,
            async updateBehavior(next) {
              const controller = controllerRef.current;
              if (controller === null) return;
              const result = await controller.update(next);
              if (result.ok) {
                setBehavior(controller.behavior);
                setActive(controller.active);
              }
            },
            gateSendPort(inner) {
              const controller = controllerRef.current;
              if (controller === null)
                return {
                  async send(payload, requestId) {
                    await inner.send(payload, requestId);
                  },
                  defer() {},
                  async resume() {},
                  deferred: false,
                  pendingCount: () => 0,
                };
              return controller.registerGate(inner);
            },
          },
    [behavior, battery, active],
  );
  return (
    <AppearanceBehaviorContext.Provider value={value}>
      {children}
    </AppearanceBehaviorContext.Provider>
  );
}

export function useAppearanceBehavior(): AppearanceBehaviorContextValue {
  const value = useContext(AppearanceBehaviorContext);
  if (value === null)
    throw new Error("useAppearanceBehavior must be used under AppearanceBehaviorProvider");
  return value;
}
