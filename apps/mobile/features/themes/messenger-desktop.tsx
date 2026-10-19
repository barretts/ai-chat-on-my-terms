import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { usePathname, useRouter } from "expo-router";
import { Appbar, Text, useTheme } from "react-native-paper";
import { useWorkspaceLayout } from "@locallab/ui-native-primitives";
import { useAppTheme } from "./provider";

export function MessengerDesktop({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const settings = useAppTheme();
  const layout = useWorkspaceLayout();
  const collapsed = settings.layout.windowCollapsed;
  const focused =
    collapsed &&
    settings.layout.chatCollapsed &&
    settings.layout.composerCollapsed;
  const opacity = useRef(new Animated.Value(0)).current;
  const [clock, setClock] = useState(new Date());
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((reduce) => {
        if (!mounted) return;
        Animated.timing(opacity, {
          toValue: 1,
          duration: reduce ? 0 : 220,
          useNativeDriver: Platform.OS !== "web",
        }).start();
      })
      .catch(() => opacity.setValue(1));
    const timer = setInterval(() => setClock(new Date()), 30000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [opacity]);
  const destination = pathname.includes("models")
    ? "Models"
    : pathname.includes("speech")
      ? "Voices"
      : pathname.includes("connections")
        ? "Connections"
        : pathname.includes("onboarding")
          ? "Welcome"
          : "Messenger";
  const desktop = theme.dark ? "#123638" : "#267a7c";
  if (layout.phone) {
    return (
      <View
        style={{
          flex: 1,
          minHeight: 0,
          backgroundColor: theme.colors.background,
        }}
      >
        {destination !== "Messenger" && destination !== "Welcome" ? (
          <Appbar.Header
            statusBarHeight={0}
            mode="small"
            style={{ backgroundColor: theme.colors.background }}
          >
            <Appbar.BackAction
              accessibilityLabel="Back to chat"
              style={{ width: 44, height: 44, margin: 4 }}
              onPress={() => router.navigate("/chat")}
            />
            <Appbar.Content
              title={destination}
              titleStyle={{ fontSize: 18, fontWeight: "600" }}
            />
          </Appbar.Header>
        ) : null}
        <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
      </View>
    );
  }
  return (
    <View
      style={[
        styles.desktop,
        layout.compact && Platform.OS === "web"
          ? { padding: 6, paddingBottom: 0 }
          : undefined,
        { backgroundColor: desktop },
      ]}
    >
      <Animated.View
        style={[
          styles.window,
          {
            opacity,
            backgroundColor: theme.colors.surface,
            borderColor: theme.dark ? "#68737f" : "#f9f6ea",
          },
        ]}
      >
        <View
          style={[
            styles.titlebar,
            (layout.compact || collapsed) && { minHeight: 44, padding: 6 },
          ]}
        >
          <View style={styles.appIcon}>
            <Text style={{ color: "#2f5fa8", fontWeight: "900", fontSize: 17 }}>
              L
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={styles.title}>
              AI Chat Messenger
            </Text>
            {!layout.compact && !collapsed ? (
              <Text style={styles.subtitle}>
                {destination} · A little nostalgia. A lot of possibility.
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              focused ? "Show all controls" : "Focus conversation"
            }
            accessibilityState={{ expanded: !focused }}
            onPress={() => {
              setMenu(false);
              void settings
                .setLayoutPreferences({
                  windowCollapsed: !focused,
                  chatCollapsed: !focused,
                  composerCollapsed: !focused,
                })
                .catch(() => {});
            }}
            style={styles.focusButton}
          >
            <Text style={{ color: "white", fontSize: 16 }}>
              {focused ? "▤" : "▣"}
            </Text>
          </Pressable>
          {layout.keyboardVisible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hide keyboard"
              onPress={() => Keyboard.dismiss()}
              style={{
                minHeight: 44,
                minWidth: 44,
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <Text style={{ color: "white", fontSize: 20 }}>▾</Text>
            </Pressable>
          ) : null}
        </View>
        {!layout.keyboardVisible && !collapsed ? (
          <View
            style={[
              styles.menuBar,
              { borderColor: theme.colors.outlineVariant },
            ]}
          >
            <Text variant="labelSmall" style={{ color: theme.colors.primary }}>
              ✦ YOUR LOCAL AI DESKTOP
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change messenger appearance"
              onPress={() => setMenu(!menu)}
              style={{ minHeight: 36, justifyContent: "center" }}
            >
              <Text variant="labelMedium">Appearance ▾</Text>
            </Pressable>
          </View>
        ) : null}
        {menu && !layout.keyboardVisible && !collapsed ? (
          <View
            style={{
              padding: 10,
              flexDirection: "row",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {(["light", "dark", "system"] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={`Use ${value} messenger appearance`}
                accessibilityState={{
                  selected: settings.themePreference === value,
                }}
                onPress={() => {
                  void settings.setThemePreference(value);
                  setMenu(false);
                }}
                style={{
                  padding: 10,
                  borderWidth: 1,
                  borderColor: theme.colors.outline,
                  backgroundColor:
                    settings.themePreference === value
                      ? theme.colors.primaryContainer
                      : theme.colors.surface,
                }}
              >
                <Text>{value[0]!.toUpperCase() + value.slice(1)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
        {!layout.compact && !collapsed ? (
          <View
            style={[
              styles.status,
              { borderColor: theme.colors.outlineVariant },
            ]}
          >
            <Text variant="labelSmall">⌁ Conversations stay with you</Text>
            <Text variant="labelSmall">{destination}</Text>
          </View>
        ) : null}
      </Animated.View>
      {!layout.keyboardVisible && !collapsed ? (
        <View
          style={[styles.taskbar, { backgroundColor: theme.colors.surface }]}
        >
          {(
            [
              { label: "Chat", icon: "✉", path: "/chat" },
              { label: "Models", icon: "▣", path: "/models" },
              { label: "Voices", icon: "♫", path: "/speech" },
            ] as const
          ).map((item) => (
            <Pressable
              key={item.path}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.label.toLowerCase()}`}
              accessibilityState={{ selected: pathname === item.path }}
              onPress={() => router.navigate(item.path)}
              style={[
                styles.task,
                {
                  borderColor: theme.colors.outline,
                  backgroundColor:
                    pathname === item.path
                      ? theme.colors.primaryContainer
                      : theme.colors.surface,
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={{ color: theme.colors.primary, fontWeight: "700" }}
              >
                {item.icon} {item.label}
              </Text>
            </Pressable>
          ))}
          {layout.showClock ? (
            <Text
              variant="labelSmall"
              style={{ marginLeft: "auto", paddingHorizontal: 6 }}
            >
              {clock.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  desktop: {
    flex: 1,
    padding: Platform.OS === "web" ? 12 : 0,
    paddingBottom: 0,
  },
  window: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    maxWidth: 1060,
    alignSelf: "center",
    borderWidth: 2,
  },
  titlebar: {
    backgroundColor: "#2f5fa8",
    padding: 10,
    minHeight: 60,
    gap: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  appIcon: {
    width: 30,
    height: 30,
    backgroundColor: "#ffe56e",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderTopColor: "white",
    borderLeftColor: "white",
    borderRightColor: "#927634",
    borderBottomColor: "#927634",
  },
  title: {
    color: "white",
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 0.2,
  },
  subtitle: { color: "#d6e4fb", fontSize: 10, marginTop: 3 },
  focusButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#86a6d8",
  },
  menuBar: {
    paddingHorizontal: 12,
    minHeight: 36,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  status: {
    minHeight: 27,
    borderTopWidth: 1,
    paddingHorizontal: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  taskbar: {
    width: "100%",
    maxWidth: 1084,
    alignSelf: "center",
    minHeight: 53,
    padding: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderTopWidth: 2,
    borderTopColor: "#f9f6ea",
  },
  task: {
    flexShrink: 1,
    minWidth: 0,
    minHeight: 44,
    borderWidth: 1,
    paddingHorizontal: 10,
    justifyContent: "center",
  },
});
