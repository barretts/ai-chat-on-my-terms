import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { parseThemeImport } from "@locallab/themes-schema";
import { useCommunity } from "./provider";
import { useAppTheme } from "../themes/provider";

export function CommunitySection() {
  const community = useCommunity();
  const themes = useAppTheme();
  const [message, setMessage] = useState<string | null>(null);

  if (!community.available)
    return (
      <View style={styles.row} testID="community-unavailable">
        <Text style={styles.title}>Community themes</Text>
        <Text style={styles.muted}>
          No community catalog is configured; themes stay on this device.
        </Text>
      </View>
    );

  async function importTheme(slug: string) {
    const detail = await community.download(slug);
    if (detail === null) {
      setMessage("Download failed.");
      return;
    }
    const parsed = parseThemeImport(detail.doc);
    if (!parsed.ok) {
      // Defense in depth: a malformed remote theme never reaches the
      // device theme store.
      setMessage(`Rejected: ${parsed.reason}`);
      return;
    }
    const saved = await themes.saveCustomTheme({
      ...parsed.theme,
      version: 1,
    });
    if (!saved.ok) {
      setMessage(saved.reason);
      return;
    }
    await themes.setThemeId(parsed.theme.id);
    setMessage(`Imported "${parsed.theme.name}".`);
  }

  async function publishCurrent() {
    const current = themes.customThemes.find(
      (item) => item.id === themes.themeId,
    );
    if (current === undefined) {
      setMessage("Create a custom theme first.");
      return;
    }
    const slug = current.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 48);
    const ok = await community.publishTheme(slug, current);
    setMessage(ok ? `Published "${current.name}".` : "Publish failed.");
  }

  return (
    <View style={styles.row} testID="community-section">
      <Text style={styles.title}>Community themes</Text>
      {community.themes.map((theme) => (
        <View key={theme.id} style={styles.product}>
          <Text>
            {theme.slug} · {theme.revisions} revision
            {theme.revisions === 1 ? "" : "s"}
          </Text>
          <Pressable
            testID={`community-import-${theme.slug}`}
            disabled={community.busy}
            onPress={() => void importTheme(theme.slug)}
          >
            <Text>Import</Text>
          </Pressable>
        </View>
      ))}
      <Pressable
        testID="community-publish"
        disabled={community.busy}
        onPress={() => void publishCurrent()}
      >
        <Text>Publish current theme</Text>
      </Pressable>
      {community.voices.length > 0 ? (
        <View testID="community-voices">
          <Text style={styles.title}>Voice packs (curated)</Text>
          {community.voices.map((voice) => (
            <Text key={voice.id}>
              {voice.name} — {voice.vendor} ({voice.languages.join(", ")})
            </Text>
          ))}
        </View>
      ) : null}
      {(message ?? community.error) !== null ? (
        <Text style={styles.error}>{message ?? community.error}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingVertical: 12 },
  title: { fontWeight: "600" },
  product: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  muted: { opacity: 0.6 },
  error: { color: "#b00020" },
});
