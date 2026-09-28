import type { ComponentProps } from "react";
import { Text } from "react-native-paper";

export type NativeTextProps = Omit<
  ComponentProps<typeof Text>,
  "accessibilityLabel"
> & {
  accessibilityLabel: string;
};

/** Paper typography with a required spoken label and native scaling enabled. */
export function NativeText({ accessibilityLabel, ...props }: NativeTextProps) {
  return (
    <Text accessibilityLabel={accessibilityLabel} allowFontScaling {...props} />
  );
}
