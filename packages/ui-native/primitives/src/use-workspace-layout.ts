import { useEffect, useState } from "react";
import { Keyboard, Platform, useWindowDimensions } from "react-native";

/** Preserve space for content on short screens and while the native keyboard is open. */
export function useWorkspaceLayout() {
  const { width, height, fontScale } = useWindowDimensions();
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
    compact: height < 700 || fontScale > 1.3 || keyboardVisible,
    keyboardVisible,
    showClock: width >= 360 && fontScale <= 1.3,
  };
}
