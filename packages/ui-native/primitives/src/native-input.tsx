import type { ComponentProps } from "react";
import { TextInput, useTheme } from "react-native-paper";

export type NativeInputProps = Omit<
  ComponentProps<typeof TextInput>,
  "accessibilityLabel"
> & {
  accessibilityLabel: string;
};

/** Paper input with an explicit accessible name and native keyboard behavior. */
export function NativeInput({
  accessibilityLabel,
  ...props
}: NativeInputProps) {
  const theme = useTheme();
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      allowFontScaling
      mode="outlined"
      {...props}
      outlineStyle={[
        theme.roundness > 0 ? { borderRadius: 12 } : undefined,
        props.outlineStyle,
      ]}
    />
  );
}
