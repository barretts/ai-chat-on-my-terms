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
      accessible={theme.roundness === 0}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="summary"
      {...props}
      elevation={0}
      style={[
        theme.roundness === 0 ? props.style : undefined,
        theme.roundness > 0
          ? {
              borderRadius: 20,
              borderWidth: 1,
              borderColor: theme.colors.outlineVariant,
              backgroundColor: theme.colors.surface,
            }
          : {
              borderRadius: 0,
              borderWidth: 2,
              borderTopColor: theme.dark ? "#756880" : "#ffffff",
              borderLeftColor: theme.dark ? "#756880" : "#ffffff",
              borderRightColor: "#89818d",
              borderBottomColor: "#89818d",
            },
        theme.roundness > 0 ? props.style : undefined,
      ]}
    >
      {children}
    </Surface>
  );
}
