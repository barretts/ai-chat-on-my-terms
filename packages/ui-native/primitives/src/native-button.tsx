import type { ComponentProps, ReactNode } from "react";
import { Button, useTheme } from "react-native-paper";

export type NativeButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "accessibilityLabel"
> & {
  accessibilityLabel: string;
  children: ReactNode;
};

/** Touch-friendly Paper button with a required VoiceOver/TalkBack label. */
export function NativeButton({
  accessibilityLabel,
  accessibilityState,
  children,
  ...props
}: NativeButtonProps) {
  const theme = useTheme();
  return (
    <Button
      accessibilityLabel={`${accessibilityLabel}${accessibilityState?.selected ? ", selected" : ""}`}
      accessibilityState={accessibilityState}
      accessibilityRole="button"
      {...props}
      contentStyle={[{ minHeight: 46 }, props.contentStyle]}
      style={[
        {
          borderRadius: 0,
          borderWidth: props.mode === "text" ? 0 : 2,
          borderTopColor: theme.dark ? "#756880" : "#ffffff",
          borderLeftColor: theme.dark ? "#756880" : "#ffffff",
          borderRightColor: "#6a6070",
          borderBottomColor: "#6a6070",
        },
        props.style,
      ]}
      labelStyle={[{ letterSpacing: 0, fontWeight: "600" }, props.labelStyle]}
    >
      {children}
    </Button>
  );
}
