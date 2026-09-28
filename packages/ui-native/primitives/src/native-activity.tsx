import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, Platform, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

/** Quiet messenger activity animation; reduced-motion users see static dots. */
export function NativeActivity({ label }: { label: string }) {
  const theme = useTheme();
  const dots = useRef([
    new Animated.Value(1),
    new Animated.Value(1),
    new Animated.Value(1),
  ]).current;
  useEffect(() => {
    let animation: Animated.CompositeAnimation | undefined;
    let mounted = true;
    const run = (reduce: boolean) => {
      animation?.stop();
      dots.forEach((dot) => dot.setValue(1));
      if (reduce || !mounted) return;
      animation = Animated.loop(
        Animated.stagger(
          150,
          dots.map((dot) =>
            Animated.sequence([
              Animated.timing(dot, {
                toValue: 0.25,
                duration: 300,
                useNativeDriver: Platform.OS !== "web",
              }),
              Animated.timing(dot, {
                toValue: 1,
                duration: 300,
                useNativeDriver: Platform.OS !== "web",
              }),
            ]),
          ),
        ),
      );
      animation.start();
    };
    void AccessibilityInfo.isReduceMotionEnabled()
      .then(run)
      .catch(() => run(true));
    const listener = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      run,
    );
    return () => {
      mounted = false;
      animation?.stop();
      listener.remove();
    };
  }, [dots]);
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
    >
      <View style={{ flexDirection: "row", gap: 3 }}>
        {dots.map((opacity, index) => (
          <Animated.View
            key={index}
            style={{
              width: 5,
              height: 5,
              backgroundColor: theme.colors.primary,
              opacity,
            }}
          />
        ))}
      </View>
      <Text
        variant="bodySmall"
        style={{ color: theme.colors.onSurfaceVariant }}
      >
        {label}
      </Text>
    </View>
  );
}
