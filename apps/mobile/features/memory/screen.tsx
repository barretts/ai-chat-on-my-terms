import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  Dialog,
  Portal,
  Searchbar,
  Switch,
  Text,
  TextInput,
} from "react-native-paper";
import { NativeButton, NativeSurface } from "@locallab/ui-native-primitives";
import type {
  LegacyMemory,
  MemoryPreferences,
  SavedMemory,
} from "@locallab/memory-extraction";
import {
  memoryScopeLabel,
  memorySourceLabel,
  type MemoryFeatureProps,
} from "./index";

/** Data > Memory. The composition root supplies its live, shared SQLite store. */
export function MemoryScreen(props: MemoryFeatureProps) {
  const [memories, setMemories] = useState<SavedMemory[]>([]);
  const [legacyMemories, setLegacyMemories] = useState<LegacyMemory[]>([]);
  const [hasMoreLegacy, setHasMoreLegacy] = useState(false);
  const [preferences, setPreferences] = useState<MemoryPreferences>({
    extractionEnabled: false,
    injectionEnabled: false,
  });
  const [query, setQuery] = useState("");
  const queryRef = useRef("");
  const reloadRequest = useRef(0);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editedText, setEditedText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [deleting, setDeleting] = useState<{
    id: string;
    legacy: boolean;
  } | null>(null);

  const reload = useCallback(async () => {
    const request = ++reloadRequest.current;
    const search = queryRef.current;
    const [entries, settings, legacy] = await Promise.all([
      props.store.list({
        ...(props.scope ? { scope: props.scope } : {}),
        query: search,
        limit: 100,
      }),
      props.store.preferences(),
      props.scope
        ? Promise.resolve([] as LegacyMemory[])
        : props.store.listLegacy(search),
    ]);
    // A save's older read must not replace a newer typed search result.
    if (request !== reloadRequest.current || search !== queryRef.current)
      return;
    setMemories(entries);
    setHasMore(entries.length === 100);
    setPreferences(settings);
    setLegacyMemories(legacy);
    setHasMoreLegacy(legacy.length === 100);
  }, [props.store, props.scope]);
  useEffect(() => {
    void reload().catch(() => setError("Could not load saved memory."));
    return () => {
      reloadRequest.current++;
    };
  }, [reload, query]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch {
      setError("Could not update memory. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const savePreferences = (next: MemoryPreferences) =>
    void run(async () => {
      await props.store.savePreferences(next);
      setPreferences(next);
      props.onPreferencesChanged?.(next);
      setStatus("Memory preferences saved");
    });
  const remove = () =>
    void run(async () => {
      if (!deleting) return;
      if (deleting.legacy) await props.store.deleteLegacy(deleting.id);
      else await props.store.delete(deleting.id);
      if (editing === deleting.id) setEditing(null);
      setDeleting(null);
      await reload();
      setStatus(
        deleting.legacy ? "Old memory entry deleted" : "Memory deleted",
      );
    });
  const matching = memories;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.heading}>
        <Text accessibilityRole="header" variant="headlineSmall">
          Data / Memory
        </Text>
        <NativeButton
          accessibilityLabel="Refresh saved memory"
          disabled={busy}
          onPress={() => void run(reload)}
        >
          Refresh
        </NativeButton>
        {props.onClose ? (
          <NativeButton
            accessibilityLabel="Close memory"
            onPress={props.onClose}
          >
            Close
          </NativeButton>
        ) : null}
      </View>
      <Text>
        Save facts to use in later conversations. You can edit or delete every
        entry and open the message it came from.
      </Text>
      <NativeSurface accessibilityLabel="Memory preferences">
        <View style={styles.card}>
          <View style={styles.toggle}>
            <Text style={styles.toggleLabel}>
              Extract memory after completed replies
            </Text>
            <Switch
              accessibilityLabel="Extract memory after completed replies"
              value={preferences.extractionEnabled}
              disabled={busy}
              onValueChange={(enabled) =>
                savePreferences({ ...preferences, extractionEnabled: enabled })
              }
            />
          </View>
          <Text>
            When enabled, eligible user and assistant text is sent to the active
            chat model for fact extraction. A remote model processes this text
            remotely. Persona privacy and generation settings also apply.
          </Text>
          <View style={styles.toggle}>
            <Text style={styles.toggleLabel}>
              Use saved facts in future prompts
            </Text>
            <Switch
              accessibilityLabel="Use saved facts in future prompts"
              value={preferences.injectionEnabled}
              disabled={busy}
              onValueChange={(enabled) =>
                savePreferences({ ...preferences, injectionEnabled: enabled })
              }
            />
          </View>
        </View>
      </NativeSurface>
      <NativeSurface accessibilityLabel="Add a saved memory fact">
        <View style={styles.card}>
          <Text variant="titleMedium">Add a fact</Text>
          <Text>
            {props.scope?.scope === "persona"
              ? "Saved to this Persona"
              : props.scope?.scope === "conversation"
                ? "Saved to this conversation"
                : "Saved across conversations"}
          </Text>
          <TextInput
            label="Memory fact"
            accessibilityLabel="New memory fact"
            multiline
            maxLength={1024}
            value={draft}
            onChangeText={setDraft}
            disabled={busy}
          />
          <NativeButton
            accessibilityLabel="Save memory fact"
            disabled={busy || !draft.trim()}
            onPress={() =>
              void run(async () => {
                await props.store.createManual(
                  draft,
                  props.scope ?? { scope: "global", scopeId: null },
                );
                setDraft("");
                await reload();
                setStatus("Memory saved");
              })
            }
          >
            Save fact
          </NativeButton>
        </View>
      </NativeSurface>
      <Searchbar
        placeholder="Search saved facts"
        accessibilityLabel="Search saved memory"
        value={query}
        onChangeText={(value) => {
          queryRef.current = value;
          setQuery(value);
        }}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {status ? <Text accessibilityLiveRegion="polite">{status}</Text> : null}
      {!matching.length && !legacyMemories.length ? (
        <Text>
          {query.trim()
            ? "No saved facts match your search."
            : "No saved memory yet."}
        </Text>
      ) : null}
      {legacyMemories.length ? (
        <>
          <Text variant="titleMedium">Saved entries awaiting scope review</Text>
          <Text>
            These older entries have a named memory pool with no known privacy
            scope. They are excluded from prompts until you choose where to save
            them.
          </Text>
          {legacyMemories.map((memory) => (
            <NativeSurface
              key={memory.id}
              accessibilityLabel="Saved memory awaiting scope review"
            >
              <View style={styles.card}>
                <Text variant="labelLarge">
                  Original memory pool: {memory.namespace}
                </Text>
                <Text selectable>{memory.content}</Text>
                {editing === memory.id ? (
                  <>
                    <TextInput
                      label="Reviewed memory fact"
                      accessibilityLabel="Review old memory fact"
                      multiline
                      maxLength={1024}
                      value={editedText}
                      onChangeText={setEditedText}
                      disabled={busy}
                    />
                    <NativeButton
                      accessibilityLabel="Save reviewed entry in global memory"
                      disabled={
                        busy || !editedText.trim() || editedText.length > 1024
                      }
                      onPress={() =>
                        void run(async () => {
                          await props.store.adoptLegacy(
                            memory.id,
                            { scope: "global", scopeId: null },
                            editedText,
                          );
                          setEditing(null);
                          await reload();
                          setStatus(
                            "Reviewed entry saved across conversations",
                          );
                        })
                      }
                    >
                      Save in global memory
                    </NativeButton>
                    <NativeButton
                      accessibilityLabel="Cancel old memory review"
                      disabled={busy}
                      onPress={() => setEditing(null)}
                    >
                      Cancel
                    </NativeButton>
                  </>
                ) : (
                  <NativeButton
                    accessibilityLabel="Review old memory privacy scope"
                    disabled={busy}
                    onPress={() => {
                      setEditing(memory.id);
                      setEditedText(
                        memory.content.length <= 1024 ? memory.content : "",
                      );
                    }}
                  >
                    Review entry
                  </NativeButton>
                )}
                <NativeButton
                  accessibilityLabel="Delete old memory entry"
                  disabled={busy}
                  onPress={() => setDeleting({ id: memory.id, legacy: true })}
                >
                  Delete
                </NativeButton>
              </View>
            </NativeSurface>
          ))}
          {hasMoreLegacy ? (
            <NativeButton
              accessibilityLabel="Load more entries awaiting scope review"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  const entries = await props.store.listLegacy(
                    query,
                    100,
                    legacyMemories.length,
                  );
                  setLegacyMemories((current) => [...current, ...entries]);
                  setHasMoreLegacy(entries.length === 100);
                })
              }
            >
              Load more old entries
            </NativeButton>
          ) : null}
        </>
      ) : null}
      {matching.map((memory) => (
        <NativeSurface
          key={memory.entry.id}
          accessibilityLabel="Saved memory entry"
        >
          <View style={styles.card}>
            <Text variant="labelLarge">
              {memoryScopeLabel(memory)} / {memorySourceLabel(memory)}
            </Text>
            {editing === memory.entry.id ? (
              <>
                <TextInput
                  label="Edit saved fact"
                  accessibilityLabel="Edit saved memory fact"
                  multiline
                  maxLength={1024}
                  value={editedText}
                  onChangeText={setEditedText}
                  disabled={busy}
                />
                <View style={styles.actions}>
                  <NativeButton
                    accessibilityLabel="Save memory edit"
                    disabled={busy || !editedText.trim()}
                    onPress={() =>
                      void run(async () => {
                        await props.store.edit(memory.entry.id, editedText);
                        setEditing(null);
                        await reload();
                        setStatus("Memory updated");
                      })
                    }
                  >
                    Save
                  </NativeButton>
                  <NativeButton
                    accessibilityLabel="Cancel memory edit"
                    disabled={busy}
                    onPress={() => setEditing(null)}
                  >
                    Cancel
                  </NativeButton>
                </View>
              </>
            ) : (
              <Text selectable>{memory.entry.content}</Text>
            )}
            {memory.source?.quote ? (
              <Text selectable>Source quote: {memory.source.quote}</Text>
            ) : null}
            <View style={styles.actions}>
              {memory.entry.provenance.sourceMessageId && props.onOpenSource ? (
                <NativeButton
                  accessibilityLabel="Open source message"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      const source = await props.store.sourceLink(
                        memory.entry.id,
                      );
                      if (!source) {
                        setStatus(
                          "The source message is no longer available on this device.",
                        );
                        return;
                      }
                      props.onOpenSource?.(
                        source.conversationId,
                        source.messageId,
                      );
                    })
                  }
                >
                  Open source
                </NativeButton>
              ) : null}
              <NativeButton
                accessibilityLabel="Edit saved memory"
                disabled={busy}
                onPress={() => {
                  setEditing(memory.entry.id);
                  setEditedText(memory.entry.content);
                }}
              >
                Edit
              </NativeButton>
              <NativeButton
                accessibilityLabel="Delete saved memory"
                disabled={busy}
                onPress={() =>
                  setDeleting({ id: memory.entry.id, legacy: false })
                }
              >
                Delete
              </NativeButton>
            </View>
          </View>
        </NativeSurface>
      ))}
      {hasMore ? (
        <NativeButton
          accessibilityLabel="Load more saved memory"
          disabled={busy}
          onPress={() =>
            void run(async () => {
              const entries = await props.store.list({
                ...(props.scope ? { scope: props.scope } : {}),
                query,
                limit: 100,
                offset: memories.length,
              });
              setMemories((current) => [...current, ...entries]);
              setHasMore(entries.length === 100);
            })
          }
        >
          Load more
        </NativeButton>
      ) : null}
      <Portal>
        <Dialog
          visible={!!deleting}
          dismissable={!busy}
          onDismiss={() => setDeleting(null)}
        >
          <Dialog.Title>Delete saved memory?</Dialog.Title>
          <Dialog.Content>
            <Text>
              This entry will stop being used in future prompts. Your original
              conversation stays in the library.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <NativeButton
              accessibilityLabel="Cancel memory deletion"
              disabled={busy}
              onPress={() => setDeleting(null)}
            >
              Cancel
            </NativeButton>
            <NativeButton
              accessibilityLabel="Confirm memory deletion"
              disabled={busy || !deleting}
              onPress={remove}
            >
              Delete
            </NativeButton>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16 },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  card: { padding: 12, gap: 12 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 12 },
  toggleLabel: { flex: 1 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  error: { color: "#B3261E" },
});
