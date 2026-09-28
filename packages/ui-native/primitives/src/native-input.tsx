import type { ComponentProps } from "react";
import { TextInput } from "react-native-paper";

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
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      allowFontScaling
      mode="outlined"
      {...props}
    />
  );
}
