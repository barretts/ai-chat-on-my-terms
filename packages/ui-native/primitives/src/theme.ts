import { Platform } from "react-native";
import {
  configureFonts,
  MD3DarkTheme,
  MD3LightTheme,
} from "react-native-paper";

const phoneFonts = configureFonts({
  config: {
    fontFamily:
      Platform.OS === "ios"
        ? "System"
        : Platform.OS === "web"
          ? "system-ui"
          : "sans-serif",
    letterSpacing: 0,
  },
});
const readingFonts = {
  ...phoneFonts,
  bodyLarge: { ...phoneFonts.bodyLarge, fontSize: 17, lineHeight: 25 },
  bodySmall: { ...phoneFonts.bodySmall, fontSize: 14, lineHeight: 20 },
  default: { ...phoneFonts.default, fontSize: 16, lineHeight: 24 },
};

/** Standard Paper surfaces and shape for the phone interface. */
export const phoneTheme = {
  ...MD3LightTheme,
  fonts: readingFonts,
  colors: {
    ...MD3LightTheme.colors,
    primary: "#2f5fa8",
    onPrimary: "#ffffff",
    primaryContainer: "#dbe7fb",
    onPrimaryContainer: "#1d3c66",
    secondary: "#55719b",
    secondaryContainer: "#dce8f7",
    onSecondaryContainer: "#16345c",
    background: "#f8f9fb",
    surface: "#ffffff",
    surfaceVariant: "#ecf0f6",
    onSurface: "#20232b",
    onSurfaceVariant: "#5f6772",
    outline: "#78818f",
    outlineVariant: "#d9e0ea",
  },
};
export const phoneDarkTheme = {
  ...MD3DarkTheme,
  fonts: readingFonts,
  colors: {
    ...MD3DarkTheme.colors,
    primary: "#a8c7fa",
    onPrimary: "#16345c",
    primaryContainer: "#2b3d57",
    onPrimaryContainer: "#d6e4fb",
    secondary: "#b3c8e8",
    secondaryContainer: "#2b3d57",
    onSecondaryContainer: "#d6e4fb",
    background: "#191b21",
    surface: "#23262e",
    surfaceVariant: "#2e3540",
    onSurface: "#edf1f8",
    onSurfaceVariant: "#b3bcc9",
    outline: "#868f9d",
    outlineVariant: "#3c4450",
  },
};

/** Paper theme mapped from the package's semantic palette. */
export const nativeTheme = {
  ...MD3LightTheme,
  roundness: 0,
  colors: {
    ...MD3LightTheme.colors,
    primary: "#2f5fa8",
    onPrimary: "#ffffff",
    primaryContainer: "#d3e3f8",
    onPrimaryContainer: "#16345c",
    secondary: "#176e70",
    secondaryContainer: "#d3e9e5",
    background: "#f1f4f8",
    surface: "#e3e8ef",
    surfaceVariant: "#dae1ea",
    onSurface: "#1f2430",
    onSurfaceVariant: "#565f6e",
    outline: "#7f8894",
    outlineVariant: "#c2cad4",
    error: "#ab263e",
    elevation: {
      ...MD3LightTheme.colors.elevation,
      level1: "#e3e8ef",
      level2: "#e3e8ef",
      level3: "#e3e8ef",
    },
  },
};

export const nativeDarkTheme = {
  ...MD3DarkTheme,
  roundness: 0,
  colors: {
    ...MD3DarkTheme.colors,
    primary: "#a8c7fa",
    onPrimary: "#16345c",
    primaryContainer: "#31465f",
    onPrimaryContainer: "#dfecfe",
    secondary: "#92d5c6",
    secondaryContainer: "#0d4a4e",
    background: "#1a1f27",
    surface: "#262d38",
    surfaceVariant: "#333b48",
    onSurface: "#e9eef5",
    onSurfaceVariant: "#bfc8d5",
    outline: "#7e8a99",
    outlineVariant: "#454d5b",
    elevation: {
      ...MD3DarkTheme.colors.elevation,
      level1: "#262d38",
      level2: "#262d38",
      level3: "#262d38",
    },
  },
};
