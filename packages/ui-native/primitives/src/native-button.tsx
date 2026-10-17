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
        theme.roundness > 0
          ? {
              borderRadius: 24,
              borderWidth: props.mode === "outlined" ? 1 : 0,
              borderColor: theme.colors.outline,
            }
          : {
              borderRadius: 0,
              borderWidth: props.mode === "text" ? 0 : 2,
              borderTopColor: theme.dark ? "#68737f" : "#ffffff",
              borderLeftColor: theme.dark ? "#68737f" : "#ffffff",
              borderRightColor: "#5c6672",
              borderBottomColor: "#5c6672",
            },
        props.style,
      ]}
      labelStyle={[{ letterSpacing: 0, fontWeight: "600" }, props.labelStyle]}
    >
      {children}
    </Button>
  );
}
