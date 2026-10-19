import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import type { AppStateStatus } from "react-native";
import { Button, Text, useTheme } from "react-native-paper";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MD3Theme } from "react-native-paper";
import { useWorkspaceLayout } from "@locallab/ui-native-primitives";
import { createLockSession } from "@locallab/app-lock";
import type {
  BiometricPort,
  EntitlementPort,
  GracePeriod,
  LockSession,
  RecoveryPort,
} from "@locallab/app-lock";
import { openMobileDatabase } from "../../platform/database-open";
import { expoSaltedHashPort, secureStoreRecordStore } from "./adapters";
import { createLockPrefsStore, ensureAppLockSchema } from "./index";
import { ErrorNotice } from "../diagnostics/error-notice";
import { describeError } from "../diagnostics/errors";

export const GRACE_LABELS: Record<GracePeriod, string> = {
  immediate: "Immediate",
  fifteenSeconds: "15 seconds",
  oneMinute: "1 minute",
  fiveMinutes: "5 minutes",
  fifteenMinutes: "15 minutes",
  oneHour: "1 hour",
};

export interface AppLockValue {
  locked: boolean;
  lockReason: string | null;
  hasLock: boolean;
  grace: GracePeriod;
  biometricAvailable: boolean;
  statusMessage: string | null;
  setGrace(grace: GracePeriod): Promise<void>;
  setPin(pin: string): Promise<{ ok: boolean; reason?: string }>;
  changePin(
    current: string,
    next: string,
  ): Promise<{ ok: boolean; reason?: string }>;
  disableWithPin(pin: string): Promise<{ ok: boolean; reason?: string }>;
  unlockWithPin(pin: string): Promise<{ ok: boolean; reason?: string }>;
  unlockWithBiometric(): Promise<{ ok: boolean; reason?: string }>;
}

const AppLockContext = createContext<AppLockValue | null>(null);

export function AppLockProvider(options: {
  children: React.ReactNode;
  entitlements?: EntitlementPort;
  recovery?: RecoveryPort | null;
  biometric?: BiometricPort | null;
}) {
  const { children, entitlements, recovery, biometric } = options;
  const sessionRef = useRef<LockSession | null>(null);
  const prefsRef = useRef<ReturnType<typeof createLockPrefsStore> | null>(null);
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [locked, setLocked] = useState(false);
  const [lockReason, setLockReason] = useState<string | null>(null);
  const [hasLock, setHasLock] = useState(false);
  const [grace, setGraceState] = useState<GracePeriod>("oneMinute");
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const syncGate = useCallback((session: LockSession) => {
    const state = session.status();
    setLocked(state.locked);
    setLockReason(state.reason);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBooted(false);
    setBootError(null);
    sessionRef.current = null;
    void (async () => {
      const db = await openMobileDatabase();
      await ensureAppLockSchema(db);
      const prefs = createLockPrefsStore(db);
      prefsRef.current = prefs;
      const session = createLockSession({
        hash: expoSaltedHashPort(),
        records: secureStoreRecordStore(),
        ...(entitlements ? { entitlements } : {}),
        recovery: recovery ?? null,
      });
      session.biometricPort(biometric ?? null);
      const loadedPrefs = await prefs.load();
      session.setGrace(loadedPrefs.grace);
      await session.coldStart();
      const nextHasLock = await session.hasLock();
      const nextBiometricAvailable = biometric
        ? await biometric.isAvailable()
        : false;
      if (cancelled) return;
      sessionRef.current = session;
      setGraceState(loadedPrefs.grace);
      setHasLock(nextHasLock);
      setBiometricAvailable(nextBiometricAvailable);
      syncGate(session);
      setBooted(true);
    })().catch((cause: unknown) => {
      if (cancelled) return;
      setBootError(
        describeError(cause, {
          operation: "Initialize app lock",
          recovery:
            "Tap Try again to reopen secure storage. The app stays locked until initialization succeeds.",
        }),
      );
    });
    const previousRef = { current: AppState.currentState };
    const subscription = AppState.addEventListener(
      "change",
      (next: AppStateStatus) => {
        const session = sessionRef.current;
        const previous = previousRef.current;
        previousRef.current = next;
        if (session === null) return;
        if (next === "background" || next === "inactive") {
          session.backgrounded(Date.now());
          return;
        }
        if (next === "active" && previous !== "active") {
          session.foregrounded(Date.now());
          syncGate(session);
        }
      },
    );
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [biometric, bootAttempt, entitlements, recovery, syncGate]);

  const value = useMemo<AppLockValue | null>(() => {
    const session = sessionRef.current;
    if (!booted || session === null) return null;
    const afterAttempt =
      (result: { ok: boolean; reason?: string }) => result;
    return {
      locked,
      lockReason,
      hasLock,
      grace,
      biometricAvailable,
      statusMessage,
      async setGrace(next) {
        session.setGrace(next);
        setGraceState(next);
        await prefsRef.current?.save({ version: 1, grace: next });
      },
      async setPin(pin) {
        const result = afterAttempt(await session.setPin(pin));
        setHasLock(await session.hasLock());
        syncGate(session);
        return result;
      },
      async changePin(current, next) {
        return afterAttempt(await session.changePin(current, next));
      },
      async disableWithPin(pin) {
        const result = afterAttempt(await session.disableWithPin(pin));
        if (result.ok) setHasLock(false);
        syncGate(session);
        return result;
      },
      async unlockWithPin(pin) {
        const result = afterAttempt(await session.unlockWithPin(pin));
        if (!result.ok) setStatusMessage(result.reason ?? null);
        syncGate(session);
        return result;
      },
      async unlockWithBiometric() {
        const result = afterAttempt(await session.unlockWithBiometric());
        if (!result.ok) setStatusMessage(result.reason ?? null);
        syncGate(session);
        return result;
      },
    };
  }, [
    biometricAvailable,
    booted,
    grace,
    hasLock,
    lockReason,
    locked,
    statusMessage,
    syncGate,
  ]);

  if (value === null)
    return bootError === null ? null : (
      <SafeAreaView
        style={{ flex: 1, justifyContent: "center", padding: 24, gap: 16 }}
      >
        <ErrorNotice message={bootError} />
        <Button
          mode="contained"
          onPress={() => {
            setBootError(null);
            setBootAttempt((attempt) => attempt + 1);
          }}
        >
          Try again
        </Button>
      </SafeAreaView>
    );
  return (
    <AppLockContext.Provider value={value}>
      {children}
      {locked && (
        <LockGate
          reason={lockReason}
          biometricAvailable={biometricAvailable}
          statusMessage={statusMessage}
          onPin={(pin) => void value.unlockWithPin(pin)}
          onBiometric={() => void value.unlockWithBiometric()}
        />
      )}
    </AppLockContext.Provider>
  );
}

function LockGate(options: {
  reason: string | null;
  biometricAvailable: boolean;
  statusMessage: string | null;
  onPin(pin: string): void;
  onBiometric(): void;
}) {
  const { reason, biometricAvailable, statusMessage, onPin, onBiometric } =
    options;
  const theme = useTheme();
  const { phone } = useWorkspaceLayout();
  const [pin, setPin] = useState("");
  const styles = StyleSheet.create(createGateStyles(theme, phone));
  const press = (digit: string) => {
    if (pin.length < 6) setPin(pin + digit);
  };
  return (
    <View
      testID="app-lock-gate"
      style={styles.gate}
      accessibilityRole="summary"
    >
      <Text style={styles.title}>AI Chat is locked</Text>
      <Text style={styles.subtitle}>
        {reason === "cold-start"
          ? "Enter your PIN to start this session."
          : "Your grace period ended; enter your PIN."}
      </Text>
      <Text testID="app-lock-pin-display" style={styles.pinDisplay}>
        {pin.replace(/\d/g, "\u2022")}
      </Text>
      {statusMessage !== null && (
        <Text testID="app-lock-status" style={styles.status}>
          {statusMessage}
        </Text>
      )}
      <View style={styles.keypad}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "<"].map(
          (key) => (
            <Pressable
              key={key}
              testID={`app-lock-key-${key}`}
              onPress={() => {
                if (key === "C") setPin("");
                else if (key === "<") setPin(pin.slice(0, -1));
                else press(key);
              }}
              style={styles.key}
              accessibilityRole="button"
              accessibilityLabel={`Key ${key}`}
            >
              <Text style={styles.keyText}>{key}</Text>
            </Pressable>
          ),
        )}
      </View>
      <View style={styles.actions}>
        <Button
          mode="contained"
          testID="app-lock-submit"
          accessibilityLabel="Unlock with PIN"
          onPress={() => {
            onPin(pin);
            setPin("");
          }}
        >
          Unlock
        </Button>
        {biometricAvailable && (
          <Button
            testID="app-lock-biometric"
            accessibilityLabel="Unlock with biometrics"
            onPress={onBiometric}
          >
            Use biometrics
          </Button>
        )}
      </View>
    </View>
  );
}

function createGateStyles(theme: MD3Theme, phone: boolean) {
  return {
    gate: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.colors.background,
      padding: phone ? 16 : 32,
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
      elevation: 1000,
    },
    title: {
      fontSize: 22,
      fontWeight: "700",
      color: theme.colors.onBackground,
    },
    subtitle: {
      marginTop: 6,
      color: theme.colors.onSurfaceVariant,
      textAlign: "center",
    },
    pinDisplay: {
      marginTop: 18,
      fontSize: 28,
      letterSpacing: 8,
      minHeight: 34,
      color: theme.colors.onBackground,
    },
    status: { marginTop: 8, color: theme.colors.error },
    keypad: {
      marginTop: 18,
      flexDirection: "row",
      flexWrap: "wrap",
      width: phone ? 240 : 300,
      justifyContent: "center",
    },
    key: {
      width: 72,
      height: 56,
      margin: 4,
      borderRadius: 12,
      backgroundColor: theme.colors.surfaceVariant,
      alignItems: "center",
      justifyContent: "center",
    },
    keyText: { fontSize: 20, color: theme.colors.onSurface },
    actions: { marginTop: 18, gap: 12, flexDirection: "row" },
  } as const;
}

export function useAppLock(): AppLockValue {
  const value = useContext(AppLockContext);
  if (value === null)
    throw new Error("useAppLock must be used inside AppLockProvider");
  return value;
}
