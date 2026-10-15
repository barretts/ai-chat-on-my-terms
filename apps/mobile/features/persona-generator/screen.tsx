import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text, TextInput, useTheme } from "react-native-paper";
import { NativeButton } from "@locallab/ui-native-primitives";
import { PERSONA_GENERATOR_LIMITS } from "@locallab/personas-generator";
import {
  generationDraft,
  type PersonaGenerateHandler,
  type PersonaGenerationDraft,
} from "./index";

/**
 * AI Persona Generator form (PE-06). The reply is applied to the open Persona
 * editor for review; nothing is saved until the user presses Save there, and
 * the generated fields stay editable the whole time.
 */
export function PersonaGeneratorForm(props: {
  generate: PersonaGenerateHandler;
  onApply: (draft: PersonaGenerationDraft) => void;
  /** Disables the form while the surrounding editor is busy. */
  editorBusy?: boolean;
}) {
  const theme = useTheme();
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
      controller.current = null;
    };
  }, []);

  const generate = () => {
    if (busy || props.editorBusy === true) return;
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setNote("Generating with the selected model…");
    void props
      .generate(idea, active.signal)
      .then((result) => {
        if (!alive.current) return;
        if (result.status === "generated") {
          props.onApply(generationDraft(result.persona));
          setNote(
            "Applied. Review and edit the fields, then save. Nothing is stored yet.",
          );
        } else if (result.status === "canceled") {
          setNote("Generation canceled.");
        } else {
          setNote(result.message);
        }
      })
      .catch(() => {
        if (!alive.current) return;
        setNote(
          "Generation failed before it reached the model. Choose a model in Connections and try again.",
        );
      })
      .finally(() => {
        if (controller.current === active) controller.current = null;
        if (alive.current) setBusy(false);
      });
  };

  return (
    <View
      accessibilityLabel="AI Persona Generator"
      style={[styles.card, { borderColor: theme.colors.outlineVariant }]}
    >
      <Text variant="titleMedium">Generate a starting profile</Text>
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        The selected model drafts a name, description, and instructions. You
        review and edit before anything is saved.
      </Text>
      <TextInput
        label="Describe the Persona"
        accessibilityLabel="Persona idea"
        value={idea}
        multiline
        maxLength={PERSONA_GENERATOR_LIMITS.ideaCharacters}
        onChangeText={setIdea}
        disabled={busy}
      />
      <View style={styles.actions}>
        <NativeButton
          accessibilityLabel="Generate Persona profile"
          mode="contained"
          disabled={busy || props.editorBusy === true}
          onPress={generate}
        >
          {busy ? "Generating…" : "Generate"}
        </NativeButton>
        {busy ? (
          <NativeButton
            accessibilityLabel="Cancel Persona generation"
            mode="outlined"
            onPress={() => controller.current?.abort()}
          >
            Cancel
          </NativeButton>
        ) : null}
      </View>
      {note ? (
        <Text accessibilityLiveRegion="polite" variant="bodySmall">
          {note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 8,
    padding: 12,
    marginVertical: 8,
    borderWidth: 1,
    borderRadius: 12,
  },
  actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
});
