import type { ReactNode } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { Button, Modal, Portal, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** A brief task overlay using Paper's modal, surfaces, and dismissal behavior. */
export function PhoneSheet({
  visible,
  title,
  testID,
  closeLabel,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  testID: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <Portal>
      <Modal
        testID={testID}
        visible={visible}
        onDismiss={onClose}
        overlayAccessibilityLabel={`Dismiss ${title.toLowerCase()}`}
        style={{ justifyContent: "flex-end", paddingHorizontal: 12 }}
        contentContainerStyle={{
          backgroundColor: theme.colors.surface,
          borderRadius: 28,
          maxHeight: Math.min(
            height * 0.85,
            height - insets.top - insets.bottom - 24,
          ),
          width: "100%",
          maxWidth: 560,
          alignSelf: "center",
          overflow: "hidden",
          marginBottom: 12,
        }}
      >
        <Text
          variant="titleLarge"
          accessibilityRole="header"
          style={{ padding: 24, paddingBottom: 16 }}
        >
          {title}
        </Text>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={{ flexShrink: 1 }}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 8 }}
        >
          {children}
        </ScrollView>
        <View style={{ padding: 16, paddingTop: 8 }}>
          <Button
            mode="contained-tonal"
            accessibilityLabel={closeLabel}
            contentStyle={{ minHeight: 48 }}
            onPress={onClose}
          >
            Done
          </Button>
        </View>
      </Modal>
    </Portal>
  );
}
