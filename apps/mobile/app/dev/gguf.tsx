import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Device from "expo-device";
import { useLocalSearchParams } from "expo-router";
import { runGgufProbe, type GgufProbeResult } from "@locallab/compat-gguf-ios";

export default function GgufProbeRoute() {
  const params = useLocalSearchParams<{
    modelUri?: string;
    modelSha256?: string;
    buildId?: string;
  }>();
  const [result, setResult] = useState<GgufProbeResult | null>(null);
  const [tokens, setTokens] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setResult(null);
    setTokens("");
    if (!params.modelUri || !params.modelSha256 || !params.buildId) {
      setError(
        "Provide local modelUri, modelSha256, and buildId route params.",
      );
      return;
    }
    try {
      const probe = await runGgufProbe({
        modelUri: params.modelUri,
        modelSha256: params.modelSha256,
        buildId: params.buildId,
        device: {
          isPhysicalDevice: Device.isDevice,
          model: Device.modelName ?? "unknown-device",
          osVersion: Device.osVersion ?? "unknown-os",
        },
        onToken: (token) => setTokens((current) => current + token),
      });
      setResult(probe);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Native probe failed");
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>
        iPhone GGUF probe
      </Text>
      <Text>
        Pass a local file URI, model SHA-256, and native build ID as route
        parameters. Results from simulators are labeled unsupported.
      </Text>
      <Pressable accessibilityRole="button" onPress={run} style={styles.button}>
        <Text style={styles.buttonText}>
          Run bounded load and cancellation probe
        </Text>
      </Pressable>
      {tokens ? (
        <Text accessibilityLabel="Generated probe tokens">{tokens}</Text>
      ) : null}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {result ? (
        <View>
          <Text accessibilityRole="header">Probe receipt</Text>
          <Text selectable>{JSON.stringify(result, null, 2)}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, padding: 24, gap: 16 },
  title: { fontSize: 24, fontWeight: "700" },
  button: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: "#315fce",
  },
  buttonText: { color: "white", fontWeight: "600" },
});
