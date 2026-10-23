import { useEffect, useState } from "react";
import { Keyboard, Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Preserve space for content on short screens and while the native keyboard is open. */
export function useWorkspaceLayout() {
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const contentWidth = width - insets.left - insets.right;
  const contentHeight = height - insets.top - insets.bottom;
  const touchLayout =
    Platform.OS !== "web" ||
    (typeof window !== "undefined" &&
      window.matchMedia?.("(pointer: coarse)").matches === true);
  const [keyboardVisible, setKeyboardVisible] = useState(
    () => Keyboard.isVisible?.() ?? false,
  );
  useEffect(() => {
    if (Platform.OS === "web") return;
    const shown = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hidden = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardVisible(false),
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return {
    width,
    fontScale,
    phone: contentWidth < 600 || (contentHeight < 600 && touchLayout),
    compact: contentHeight < 700 || fontScale > 1.3 || keyboardVisible,
    keyboardVisible,
    showClock: contentWidth >= 360 && fontScale <= 1.3,
  };
}
