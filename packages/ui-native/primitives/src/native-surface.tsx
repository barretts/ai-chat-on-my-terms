import type { ComponentProps, ReactNode } from "react";
import { Surface, useTheme } from "react-native-paper";

export type NativeSurfaceProps = Omit<
  ComponentProps<typeof Surface>,
  "accessibilityLabel"
> & {
  accessibilityLabel: string;
  children: ReactNode;
};

/** Paper surface exposed as a labelled native region. */
export function NativeSurface({
  accessibilityLabel,
  children,
  ...props
}: NativeSurfaceProps) {
  const theme = useTheme();
  return (
    <Surface
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="summary"
      {...props}
      elevation={0}
      style={[
        props.style,
        {
          borderRadius: 0,
          borderWidth: 2,
          borderTopColor: theme.dark ? "#756880" : "#ffffff",
          borderLeftColor: theme.dark ? "#756880" : "#ffffff",
          borderRightColor: "#89818d",
          borderBottomColor: "#89818d",
        },
      ]}
    >
      {children}
    </Surface>
  );
}
