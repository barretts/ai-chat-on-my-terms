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
    primary: "#59328b",
    onPrimary: "#ffffff",
    primaryContainer: "#eee7f7",
    onPrimaryContainer: "#3f285d",
    background: "#faf9f7",
    surface: "#ffffff",
    surfaceVariant: "#f0edf3",
    onSurface: "#26232b",
    onSurfaceVariant: "#68616f",
    outline: "#827a89",
    outlineVariant: "#e1dce6",
  },
};
export const phoneDarkTheme = {
  ...MD3DarkTheme,
  fonts: readingFonts,
  colors: {
    ...MD3DarkTheme.colors,
    primary: "#d3b0ff",
    onPrimary: "#2f1849",
    primaryContainer: "#362b45",
    onPrimaryContainer: "#eadcfb",
    background: "#19171c",
    surface: "#242128",
    surfaceVariant: "#322d38",
    onSurface: "#f2edf5",
    onSurfaceVariant: "#bdb5c5",
    outline: "#938a9d",
    outlineVariant: "#403947",
  },
};

/** Paper theme mapped from the package's semantic palette. */
export const nativeTheme = {
  ...MD3LightTheme,
  roundness: 0,
  colors: {
    ...MD3LightTheme.colors,
    primary: "#59328b",
    onPrimary: "#ffffff",
    primaryContainer: "#e6daf7",
    onPrimaryContainer: "#362052",
    secondary: "#176e70",
    secondaryContainer: "#d3e9e5",
    background: "#f4f1e8",
    surface: "#e5e1d6",
    surfaceVariant: "#dcd8ce",
    onSurface: "#252331",
    onSurfaceVariant: "#5a5667",
    outline: "#8d8790",
    outlineVariant: "#c6c0c8",
    error: "#ab263e",
    elevation: {
      ...MD3LightTheme.colors.elevation,
      level1: "#e5e1d6",
      level2: "#e5e1d6",
      level3: "#e5e1d6",
    },
  },
};

export const nativeDarkTheme = {
  ...MD3DarkTheme,
  roundness: 0,
  colors: {
    ...MD3DarkTheme.colors,
    primary: "#d3b0ff",
    onPrimary: "#2f1849",
    primaryContainer: "#49315f",
    onPrimaryContainer: "#f1e4ff",
    secondary: "#92d5c6",
    background: "#211e2a",
    surface: "#302b39",
    surfaceVariant: "#403949",
    onSurface: "#f1ece2",
    onSurfaceVariant: "#c8bfd2",
    outline: "#8a7b9b",
    outlineVariant: "#544b61",
    elevation: {
      ...MD3DarkTheme.colors.elevation,
      level1: "#302b39",
      level2: "#302b39",
      level3: "#302b39",
    },
  },
};
