import { Stack, type ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { useTheme, PaperProvider, Button } from "react-native-paper";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AppThemeProvider } from "../features/themes/provider";
import { MessengerDesktop } from "../features/themes/messenger-desktop";
import { installNativeAbortCompatibility } from "../platform/abort-compatibility";
import { AppLockProvider } from "../features/app-lock/provider";
import { BackupProvider } from "../features/backup/provider";
import { AccountProvider } from "../features/account/provider";
import { DiagnosticsProvider } from "../features/diagnostics/provider";
import { BillingProvider, useBilling } from "../features/billing/provider";
import { CommunityProvider } from "../features/community/provider";
import { SupportProvider } from "../features/support/provider";
import type { ReactNode } from "react";
import { AppearanceBehaviorProvider } from "../features/appearance-behavior/provider";
import { reactNativeBatterySource } from "../features/appearance-behavior/battery-rn";
import { ErrorNotice } from "../features/diagnostics/error-notice";
import { describeError } from "../features/diagnostics/errors";

installNativeAbortCompatibility();

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const message = describeError(error, {
    operation: "Render app screen",
    recovery:
      "Tap Try again. If the screen keeps failing, enable trace recording and share the log.",
  });
  return (
    <PaperProvider>
      <DiagnosticsProvider>
        <ScrollView
          contentContainerStyle={{ padding: 24, paddingTop: 64, gap: 16 }}
        >
          <ErrorNotice message={message} />
          <Button mode="contained" onPress={() => void retry()}>
            Try again
          </Button>
        </ScrollView>
      </DiagnosticsProvider>
    </PaperProvider>
  );
}

function RootNavigator() {
  const theme = useTheme();
  return (
    <SafeAreaView
      testID="app-safe-area"
      edges={["top", "bottom", "left", "right"]}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
    >
      <StatusBar style={theme.dark ? "light" : "dark"} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <MessengerDesktop>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: theme.colors.background },
            }}
          />
        </MessengerDesktop>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ProAwareLockProvider({ children }: { children: ReactNode }) {
  const { entitlementPort } = useBilling();
  return (
    <AppLockProvider
      {...(entitlementPort === null ? {} : { entitlements: entitlementPort })}
    >
      {children}
    </AppLockProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppThemeProvider>
        <AppearanceBehaviorProvider
          batterySource={reactNativeBatterySource()}
        >
          <AccountProvider>
            <BillingProvider>
              <CommunityProvider>
                <SupportProvider>
                  <ProAwareLockProvider>
                    <BackupProvider>
                      <DiagnosticsProvider>
                        <RootNavigator />
                      </DiagnosticsProvider>
                    </BackupProvider>
                  </ProAwareLockProvider>
                </SupportProvider>
              </CommunityProvider>
            </BillingProvider>
          </AccountProvider>
        </AppearanceBehaviorProvider>
      </AppThemeProvider>
    </SafeAreaProvider>
  );
}
