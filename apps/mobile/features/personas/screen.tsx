import { useCallback, useEffect, useRef, useState } from "react";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import {
  Avatar,
  Dialog,
  MD3DarkTheme,
  MD3LightTheme,
  Portal,
  RadioButton,
  Text,
  TextInput,
  ThemeProvider,
  useTheme,
  type MD3Theme,
} from "react-native-paper";
import {
  NativeButton,
  NativeSurface,
  NativeDropdown,
} from "@locallab/ui-native-primitives";
import { speechVoices } from "../../platform/speech";
import {
  DEFAULT_PERSONA_APPEARANCE,
  PersonaLibraryError,
} from "@locallab/personas-library";
import { PersonaAvatarError } from "./avatar";
import {
  personaEditorDraft,
  personaInitials,
  type PersonaEditorDraft,
  type PersonaAvatar,
  type PersonaFeatureProps,
  type PersonaRecord,
} from "./index";

export function PersonaScreen(props: PersonaFeatureProps) {
  const appTheme = useTheme();
  const [personas, setPersonas] = useState<PersonaRecord[]>([]);
  const [editing, setEditing] = useState<PersonaRecord | null>(null);
  const [ownerId, setOwnerId] = useState("");
  const [draft, setDraft] = useState<PersonaEditorDraft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [avatarUris, setAvatarUris] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<PersonaRecord | null>(null);
  const pendingAvatars = useRef(new Map<string, string>());
  const alive = useRef(true);
  const picker = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    const records = await props.library.list();
    const selected = props.currentConversationId
      ? await props.library.selected(props.currentConversationId)
      : null;
    if (!alive.current) return;
    setPersonas(records);
    setSelectedId(selected?.id ?? null);
    if (props.avatarPort) {
      const entries = await Promise.all(
        records
          .filter((record) => record.photoAttachmentId)
          .map(async (record) => {
            const id = record.photoAttachmentId!;
            return [
              id,
              await props.avatarPort!.resolve(id).catch(() => undefined),
            ] as const;
          }),
      );
      if (alive.current)
        setAvatarUris(
          Object.fromEntries(
            entries.filter(
              (entry): entry is readonly [string, string] => !!entry[1],
            ),
          ),
        );
    }
  }, [props.library, props.avatarPort, props.currentConversationId]);

  useEffect(() => {
    alive.current = true;
    void reload().catch(() => {
      if (alive.current)
        setError("Could not load Personas. Reopen the library and try again.");
    });
    const port = props.avatarPort;
    const pending = pendingAvatars.current;
    return () => {
      alive.current = false;
      picker.current?.abort();
      for (const [id, owner] of pending)
        void port?.release(id, owner).catch(() => undefined);
      pending.clear();
    };
  }, [reload, props.avatarPort]);

  const perform = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof PersonaLibraryError ||
            cause instanceof PersonaAvatarError
            ? cause.message
            : "The Persona action could not finish. Try again.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const releasePendingAvatars = async () => {
    await Promise.all(
      [...pendingAvatars.current].map(async ([id, owner]) => {
        try {
          await props.avatarPort?.release(id, owner);
          pendingAvatars.current.delete(id);
        } catch {
          // A committed profile edit stays committed. Retry unused-image cleanup on exit.
        }
      }),
    );
  };

  const discardDraft = async () => {
    picker.current?.abort();
    await releasePendingAvatars();
    setDraft(null);
    setEditing(null);
    setOwnerId("");
  };

  const openEditor = (record?: PersonaRecord) => {
    setEditing(record ?? null);
    setOwnerId(record?.id ?? props.createId());
    setDraft(
      record
        ? personaEditorDraft(record)
        : {
            name: "",
            description: "",
            prompt: "",
            photoAttachmentId: null,
            appearance: { ...DEFAULT_PERSONA_APPEARANCE },
          },
    );
    setError("");
  };

  const chooseAvatar = () =>
    void perform(async () => {
      if (!draft || !props.avatarPort) return;
      const controller = new AbortController();
      picker.current = controller;
      let image: PersonaAvatar | undefined;
      try {
        image = await props.avatarPort.pick(ownerId, controller.signal);
      } finally {
        if (picker.current === controller) picker.current = null;
      }
      if (!image) return;
      if (!alive.current) {
        await props.avatarPort.release(image.attachmentId, ownerId);
        return;
      }
      if (image.attachmentId !== editing?.photoAttachmentId)
        pendingAvatars.current.set(image.attachmentId, ownerId);
      setAvatarUris((current) => ({
        ...current,
        [image.attachmentId]: image.uri,
      }));
      setDraft((current) =>
        current
          ? { ...current, photoAttachmentId: image.attachmentId }
          : current,
      );
    });

  const save = () =>
    void perform(async () => {
      if (!draft) return;
      const record = editing
        ? await props.library.update(editing.id, {
            ...draft,
            expectedRevision: editing.revision,
          })
        : await props.library.create({ ...draft, id: ownerId });
      // Saved avatars retain their owner; discarded picks and the previous avatar are released.
      if (record.photoAttachmentId)
        pendingAvatars.current.delete(record.photoAttachmentId);
      if (
        editing?.photoAttachmentId &&
        editing.photoAttachmentId !== record.photoAttachmentId
      )
        pendingAvatars.current.set(editing.photoAttachmentId, editing.id);
      await discardDraft();
      await reload();
      await props.onProfilesChanged?.();
    });

  const remove = (record: PersonaRecord) =>
    void perform(async () => {
      await props.library.delete(record.id);
      setDeleting(null);
      if (record.photoAttachmentId)
        pendingAvatars.current.set(record.photoAttachmentId, record.id);
      await releasePendingAvatars();
      await reload();
      await props.onProfilesChanged?.();
    });

  const avatar = (
    name: string,
    photoId: string | null,
    shape: "circle" | "square",
    color: string,
  ) => {
    const style = {
      borderRadius: shape === "circle" ? 28 : 8,
      backgroundColor: color,
    };
    return photoId && avatarUris[photoId] ? (
      <Image
        accessible
        accessibilityLabel={`${name} avatar`}
        accessibilityIgnoresInvertColors
        source={{ uri: avatarUris[photoId] }}
        style={[styles.avatarImage, style]}
      />
    ) : (
      <Avatar.Text
        size={56}
        label={personaInitials(name)}
        style={style}
        color={contrastText(color)}
      />
    );
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.row}>
        <Text accessibilityRole="header" variant="headlineSmall">
          Personas
        </Text>
        {props.onClose ? (
          <NativeButton
            accessibilityLabel="Close Persona library"
            onPress={props.onClose}
            disabled={busy}
          >
            Close
          </NativeButton>
        ) : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {draft ? (
        <ThemeProvider
          theme={profileTheme(appTheme, draft.appearance.backgroundColor)}
        >
          <NativeSurface
            accessibilityLabel="Persona profile editor"
            style={[
              styles.card,
              {
                backgroundColor: /^#[\da-f]{6}$/i.test(
                  draft.appearance.backgroundColor,
                )
                  ? draft.appearance.backgroundColor
                  : DEFAULT_PERSONA_APPEARANCE.backgroundColor,
              },
            ]}
          >
            <Text variant="titleLarge">
              {editing ? "Edit profile" : "Create Persona"}
            </Text>
            {avatar(
              draft.name,
              draft.photoAttachmentId,
              draft.appearance.avatarShape,
              /^#[\da-f]{6}$/i.test(draft.appearance.accentColor)
                ? draft.appearance.accentColor
                : DEFAULT_PERSONA_APPEARANCE.accentColor,
            )}
            <TextInput
              label="Name"
              accessibilityLabel="Name"
              value={draft.name}
              maxLength={120}
              onChangeText={(name) => setDraft({ ...draft, name })}
              disabled={busy}
            />
            <TextInput
              label="About this Persona"
              accessibilityLabel="About this Persona"
              value={draft.description}
              multiline
              maxLength={4096}
              onChangeText={(description) =>
                setDraft({ ...draft, description })
              }
              disabled={busy}
            />
            <TextInput
              label="System prompt"
              accessibilityLabel="System prompt"
              value={draft.prompt}
              multiline
              maxLength={65536}
              onChangeText={(prompt) => setDraft({ ...draft, prompt })}
              disabled={busy}
            />
            <NativeDropdown
              label="Persona voice"
              value={
                typeof draft.profile?.speechVoiceId === "string"
                  ? draft.profile.speechVoiceId
                  : "default"
              }
              options={[
                { value: "default", label: "Use selected studio voice" },
                ...speechVoices.map((voice) => ({
                  value: voice.id,
                  label: voice.name,
                  detail: voice.description,
                })),
              ]}
              disabled={busy}
              onChange={(speechVoiceId) =>
                setDraft({
                  ...draft,
                  profile: { ...draft.profile, speechVoiceId },
                })
              }
            />
            <NativeDropdown
              label="Persona voice speed"
              value={
                typeof draft.profile?.speechRate === "number"
                  ? String(draft.profile.speechRate)
                  : "default"
              }
              options={[
                { value: "default", label: "Use studio speed" },
                ...[0.75, 1, 1.15, 1.3, 1.5].map((rate) => ({
                  value: String(rate),
                  label: `${rate}×`,
                })),
              ]}
              disabled={busy}
              onChange={(rate) => {
                const profile = { ...draft.profile };
                if (rate === "default") profile.speechRate = null;
                else profile.speechRate = Number(rate);
                setDraft({ ...draft, profile });
              }}
            />
            <Text>
              Profile changes apply to the next response. Current responses keep
              the profile they started with.
            </Text>
            <View style={styles.row}>
              <NativeButton
                accessibilityLabel="Choose Persona avatar"
                disabled={busy || !props.avatarPort}
                onPress={chooseAvatar}
              >
                Choose avatar
              </NativeButton>
              {draft.photoAttachmentId ? (
                <NativeButton
                  accessibilityLabel="Remove Persona avatar"
                  disabled={busy}
                  onPress={() =>
                    setDraft({ ...draft, photoAttachmentId: null })
                  }
                >
                  Remove avatar
                </NativeButton>
              ) : null}
            </View>
            {!props.avatarPort ? (
              <Text>Photo selection is unavailable in this app build.</Text>
            ) : null}
            <Text variant="titleMedium">Appearance</Text>
            <TextInput
              label="Accent color"
              accessibilityLabel="Accent color"
              value={draft.appearance.accentColor}
              autoCapitalize="characters"
              maxLength={7}
              onChangeText={(accentColor) =>
                setDraft({
                  ...draft,
                  appearance: { ...draft.appearance, accentColor },
                })
              }
              disabled={busy}
            />
            <TextInput
              label="Profile background color"
              accessibilityLabel="Profile background color"
              value={draft.appearance.backgroundColor}
              autoCapitalize="characters"
              maxLength={7}
              onChangeText={(backgroundColor) =>
                setDraft({
                  ...draft,
                  appearance: { ...draft.appearance, backgroundColor },
                })
              }
              disabled={busy}
            />
            <RadioButton.Group
              value={draft.appearance.avatarShape}
              onValueChange={(shape) =>
                setDraft({
                  ...draft,
                  appearance: {
                    ...draft.appearance,
                    avatarShape: shape === "square" ? "square" : "circle",
                  },
                })
              }
            >
              <RadioButton.Item
                label="Circle avatar"
                accessibilityLabel={`Circle avatar${draft.appearance.avatarShape === "circle" ? ", selected" : ""}`}
                value="circle"
                disabled={busy}
              />
              <RadioButton.Item
                label="Square avatar"
                accessibilityLabel={`Square avatar${draft.appearance.avatarShape === "square" ? ", selected" : ""}`}
                value="square"
                disabled={busy}
              />
            </RadioButton.Group>
            <View style={styles.row}>
              <NativeButton
                accessibilityLabel="Save Persona profile"
                onPress={save}
                disabled={busy || !draft.name.trim()}
              >
                {busy ? "Saving..." : "Save profile"}
              </NativeButton>
              <NativeButton
                accessibilityLabel="Cancel Persona profile editing"
                onPress={() => void perform(discardDraft)}
                disabled={busy}
              >
                Cancel
              </NativeButton>
            </View>
          </NativeSurface>
        </ThemeProvider>
      ) : (
        <>
          <NativeButton
            accessibilityLabel="Create Persona"
            disabled={busy}
            onPress={() => openEditor()}
          >
            Create Persona
          </NativeButton>
          {personas.map((record) => (
            <ThemeProvider
              key={record.id}
              theme={profileTheme(appTheme, record.appearance.backgroundColor)}
            >
              <NativeSurface
                style={[
                  styles.card,
                  { backgroundColor: record.appearance.backgroundColor },
                ]}
                accessibilityLabel={`Persona profile ${record.name}`}
              >
                <View style={styles.row}>
                  {avatar(
                    record.name,
                    record.photoAttachmentId,
                    record.appearance.avatarShape,
                    record.appearance.accentColor,
                  )}
                  <View style={styles.identity}>
                    <Text variant="titleLarge">{record.name}</Text>
                    {record.isDefault ? (
                      <Text>Default profile</Text>
                    ) : record.isStarter ? (
                      <Text>Starter assistant</Text>
                    ) : null}
                    {selectedId === record.id ? (
                      <Text>Selected for the current chat</Text>
                    ) : null}
                  </View>
                </View>
                {record.photoAttachmentId &&
                !avatarUris[record.photoAttachmentId] ? (
                  <Text>Saved avatar is unavailable on this device.</Text>
                ) : null}
                {record.description ? <Text>{record.description}</Text> : null}
                <Text numberOfLines={3}>
                  {record.prompt || "No additional system prompt"}
                </Text>
                <View style={styles.row}>
                  <NativeButton
                    accessibilityLabel={`Edit profile for ${record.name}`}
                    disabled={busy}
                    onPress={() => openEditor(record)}
                  >
                    Edit profile
                  </NativeButton>
                  <NativeButton
                    accessibilityLabel={`Start chat with ${record.name}`}
                    disabled={busy}
                    onPress={() =>
                      void perform(async () =>
                        props.onLaunchChat(
                          await props.library.chatIntent(record.id),
                        ),
                      )
                    }
                  >
                    Start chat
                  </NativeButton>
                  <NativeButton
                    accessibilityLabel={`Add ${record.name} to a group`}
                    disabled={busy || !!props.groupUnavailableReason}
                    onPress={() =>
                      void perform(async () =>
                        props.onAddToGroup(
                          await props.library.groupIntent(
                            record.id,
                            props.currentGroupRoomId,
                          ),
                        ),
                      )
                    }
                  >
                    Add to group
                  </NativeButton>
                  {props.currentConversationId ? (
                    <NativeButton
                      accessibilityLabel={`Use ${record.name} in current chat`}
                      disabled={busy || selectedId === record.id}
                      onPress={() =>
                        void perform(async () => {
                          const intent = await props.library.select(
                            props.currentConversationId!,
                            record.id,
                          );
                          await props.onSwitch?.(intent);
                          await reload();
                        })
                      }
                    >
                      Use in current chat
                    </NativeButton>
                  ) : null}
                  {!record.isDefault ? (
                    <NativeButton
                      accessibilityLabel={`Delete ${record.name}`}
                      disabled={busy}
                      onPress={() => setDeleting(record)}
                    >
                      Delete
                    </NativeButton>
                  ) : null}
                </View>
                {props.groupUnavailableReason ? (
                  <Text>{props.groupUnavailableReason}</Text>
                ) : null}
              </NativeSurface>
            </ThemeProvider>
          ))}
          {personas.length === 0 ? (
            <Text>
              No Personas are available. Reopen the library and try again.
            </Text>
          ) : null}
        </>
      )}
      <Portal>
        <Dialog
          visible={!!deleting}
          dismissable={!busy}
          onDismiss={() => setDeleting(null)}
        >
          <Dialog.Title>
            {deleting ? `Delete ${deleting.name}?` : "Delete Persona?"}
          </Dialog.Title>
          <Dialog.Content>
            <Text>
              Existing conversations and responses will stay in your library.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <NativeButton
              accessibilityLabel="Cancel Persona deletion"
              disabled={busy}
              onPress={() => setDeleting(null)}
            >
              Cancel
            </NativeButton>
            <NativeButton
              accessibilityLabel="Confirm Persona deletion"
              disabled={busy || !deleting}
              onPress={() => deleting && remove(deleting)}
            >
              Delete
            </NativeButton>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </ScrollView>
  );
}

function contrastText(color: string): string {
  const valid = /^#[\da-f]{6}$/i.test(color)
    ? color
    : DEFAULT_PERSONA_APPEARANCE.backgroundColor;
  const components = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(valid.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    0.2126 * components[0]! + 0.7152 * components[1]! + 0.0722 * components[2]!;
  return luminance > 0.179 ? "#171717" : "#FFFFFF";
}

function profileTheme(appTheme: MD3Theme, color: string): MD3Theme {
  const background = /^#[\da-f]{6}$/i.test(color)
    ? color
    : DEFAULT_PERSONA_APPEARANCE.backgroundColor;
  const palette =
    contrastText(background) === "#FFFFFF" ? MD3DarkTheme : MD3LightTheme;
  return {
    ...appTheme,
    dark: palette.dark,
    colors: {
      ...palette.colors,
      background,
      surface: background,
      onSurface: contrastText(background),
    },
  };
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  card: { padding: 16, gap: 12 },
  identity: { flex: 1, minWidth: 120 },
  avatarImage: { width: 56, height: 56 },
  error: { color: "#B3261E" },
});
