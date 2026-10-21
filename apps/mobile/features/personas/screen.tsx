import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import {
  Avatar,
  Dialog,
  List,
  MD3DarkTheme,
  MD3LightTheme,
  Portal,
  RadioButton,
  Switch,
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
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import { speechVoices } from "../../platform/speech";
import { describeError } from "../diagnostics/errors";
import { ErrorNotice } from "../diagnostics/error-notice";
import { PersonaGeneratorForm } from "../persona-generator/screen";
import { readPersonaMemorySettings } from "@locallab/memory-scope";
import { DEFAULT_PERSONA_APPEARANCE } from "@locallab/personas-library";
import {
  DEFAULT_MODEL_CHOICE,
  personaModelChoices,
  personaProfileWithModel,
} from "../persona-bindings";
import { readPersonaModelSettings } from "@locallab/personas-bindings";
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
  const { phone } = useWorkspaceLayout();
  const scroll = useRef<ScrollView>(null);
  const [personas, setPersonas] = useState<PersonaRecord[]>([]);
  const [editing, setEditing] = useState<PersonaRecord | null>(null);
  const [ownerId, setOwnerId] = useState("");
  const [draft, setDraft] = useState<PersonaEditorDraft | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [avatarUris, setAvatarUris] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<PersonaRecord | null>(null);
  const pendingAvatars = useRef(new Map<string, string>());
  const alive = useRef(true);
  const picker = useRef<AbortController | null>(null);
  useEffect(() => {
    if (phone && error) scroll.current?.scrollTo({ y: 0, animated: true });
  }, [phone, error]);

  const reload = useCallback(async () => {
    const records = await props.library.list();
    const selected = props.currentConversationId
      ? await props.library.selected(props.currentConversationId)
      : null;
    if (!alive.current) return;
    setPersonas(records);
    setSelectedId(selected?.id ?? null);
    setLoaded(true);
    if (props.avatarPort) {
      const entries = await Promise.all(
        records
          .filter((record) => record.photoAttachmentId)
          .map(async (record) => {
            const id = record.photoAttachmentId!;
            return [
              id,
              await props.avatarPort!.resolve(id).catch((cause) => {
                const message = describeError(cause, {
                  operation: "Load a persona avatar image",
                  recovery:
                    "Edit this persona and choose another photo. Its instructions and chats remain available.",
                });
                if (alive.current) setError(message);
                return undefined;
              }),
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
    void reload().catch((cause) => {
      if (alive.current)
        setError(
          describeError(cause, {
            operation: "Load persona profiles",
            recovery: "Tap Reload profiles to read your personas again.",
          }),
        );
    });
    const port = props.avatarPort;
    const pending = pendingAvatars.current;
    return () => {
      alive.current = false;
      picker.current?.abort();
      for (const [id, owner] of pending)
        void port?.release(id, owner).catch((cause) => {
          describeError(cause, {
            operation: "Clean up an unused persona photo on exit",
            recovery:
              "Reopen Personas and edit the profile to retry unused photo cleanup.",
          });
        });
      pending.clear();
    };
  }, [reload, props.avatarPort]);

  const perform = async (operation: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      if (alive.current)
        setError(
          describeError(cause, {
            operation,
            recovery:
              "Check the profile fields, then try this action again. Reload profiles to check what was saved.",
          }),
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
        } catch (cause) {
          // A committed profile edit stays committed. Retry unused-image cleanup on exit.
          const message = describeError(cause, {
            operation: "Clean up an unused persona photo",
            recovery:
              "Your profile edit remains saved. Close and reopen Personas to retry photo cleanup.",
          });
          if (alive.current) setError(message);
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
    void perform("Choose a persona avatar photo", async () => {
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
    void perform(
      editing ? "Save persona profile changes" : "Create a persona profile",
      async () => {
        if (!draft) return;
        const record = editing
          ? await props.library.update(editing.id, {
              ...draft,
              expectedRevision: editing.revision,
            })
          : await props.library.create({ ...draft, id: ownerId });
        await props.onPersonaMemoryPolicy?.(
          record.id,
          readPersonaMemorySettings(record.profile).share === true,
        );
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
      },
    );

  const remove = (record: PersonaRecord) =>
    void perform("Delete a persona profile", async () => {
      await props.library.delete(record.id);
      setDeleting(null);
      if (record.photoAttachmentId)
        pendingAvatars.current.set(record.photoAttachmentId, record.id);
      await releasePendingAvatars();
      await reload();
      await props.onProfilesChanged?.();
    });

  const memory = readPersonaMemorySettings(draft?.profile);
  const memorySwitch = (
    key: "extract" | "inject" | "share",
    value: boolean,
  ) => {
    if (!draft) return;
    setDraft({
      ...draft,
      profile: {
        ...draft.profile,
        memory: { ...readPersonaMemorySettings(draft.profile), [key]: value },
      },
    });
  };

  const modelBinding = readPersonaModelSettings(draft?.profile);
  const setModelBinding = (choice: string) => {
    if (!draft) return;
    setDraft({
      ...draft,
      profile: personaProfileWithModel(
        draft.profile,
        choice === DEFAULT_MODEL_CHOICE ? null : choice,
      ),
    });
  };

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
      ref={scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.row}>
        <Text accessibilityRole="header" variant="headlineSmall">
          {phone ? "Your personas" : "Personas"}
        </Text>
        {props.onClose ? (
          <NativeButton
            accessibilityLabel="Close Persona library"
            onPress={props.onClose}
            disabled={busy}
          >
            Back to chat
          </NativeButton>
        ) : null}
      </View>
      <Text>
        Personas change how the assistant replies. Use one in this chat, start a
        new chat with it, or create your own instructions.
      </Text>
      {props.loadStarterPack ? (
        <NativeButton
          accessibilityLabel="Load character pack"
          mode="outlined"
          disabled={busy}
          onPress={() =>
            void perform("Load character pack", async () => {
              await props.loadStarterPack?.();
              await reload();
            })
          }
        >
          Load character pack
        </NativeButton>
      ) : null}
      {error ? (
        <View style={{ gap: 8 }}>
          <ErrorNotice message={error} />
          <NativeButton
            accessibilityLabel="Reload Persona profiles"
            mode="outlined"
            disabled={busy}
            onPress={() => void perform("Reload persona profiles", reload)}
          >
            Reload profiles
          </NativeButton>
        </View>
      ) : null}
      {!loaded && !error ? (
        <Text accessibilityLiveRegion="polite">Loading profiles…</Text>
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
            {!editing && props.generatePersona ? (
              <PersonaGeneratorForm
                generate={props.generatePersona}
                editorBusy={busy}
                onApply={(fields) =>
                  setDraft({
                    ...draft,
                    name: fields.name,
                    description: fields.description,
                    prompt: fields.prompt,
                    appearance: fields.appearance,
                  })
                }
              />
            ) : null}
            {avatar(
              draft.name,
              draft.photoAttachmentId,
              draft.appearance.avatarShape,
              /^#[\da-f]{6}$/i.test(draft.appearance.accentColor)
                ? draft.appearance.accentColor
                : DEFAULT_PERSONA_APPEARANCE.accentColor,
            )}
            <TextInput
              label="Name (required)"
              accessibilityLabel="Name"
              value={draft.name}
              maxLength={120}
              onChangeText={(name) => setDraft({ ...draft, name })}
              disabled={busy}
            />
            <TextInput
              label="Description (optional)"
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
              label="Instructions for replies"
              accessibilityLabel="System prompt"
              value={draft.prompt}
              multiline
              maxLength={65536}
              onChangeText={(prompt) => setDraft({ ...draft, prompt })}
              disabled={busy}
            />
            <PersonaEditorOptions phone={phone} title="Voice">
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
                Download the chosen voice pack in Voices before reading aloud.
              </Text>
            </PersonaEditorOptions>
            <PersonaEditorOptions phone={phone} title="Memory">
              <View style={styles.row}>
                <Text>Save new facts from this Persona's chats</Text>
                <Switch
                  accessibilityLabel="Persona fact saving switch"
                  value={
                    memory.extract ??
                    props.globalMemorySettings?.extract ??
                    true
                  }
                  disabled={busy}
                  onValueChange={(value) => memorySwitch("extract", value)}
                />
              </View>
              <View style={styles.row}>
                <Text>Use saved facts when this Persona replies</Text>
                <Switch
                  accessibilityLabel="Persona fact usage switch"
                  value={
                    memory.inject ?? props.globalMemorySettings?.inject ?? true
                  }
                  disabled={busy}
                  onValueChange={(value) => memorySwitch("inject", value)}
                />
              </View>
              <View style={styles.row}>
                <Text>Share this Persona's facts</Text>
                <Switch
                  accessibilityLabel="Persona fact sharing switch"
                  value={memory.share === true}
                  disabled={busy}
                  onValueChange={(value) => memorySwitch("share", value)}
                />
              </View>
              <Text variant="bodySmall">
                Unshared Persona facts never enter the global memory pool or
                another chat's prompt. Editing these switches never resets the
                conversation.
              </Text>
            </PersonaEditorOptions>
            <PersonaEditorOptions phone={phone} title="Model">
              <NativeDropdown
                label="Persona model"
                value={modelBinding.connectionId ?? DEFAULT_MODEL_CHOICE}
                options={personaModelChoices(
                  props.modelConnections ?? [],
                  modelBinding.connectionId,
                )}
                disabled={busy}
                onChange={setModelBinding}
              />
              <Text variant="bodySmall">
                A bound model belongs to this Persona: switching the chat
                provider never replaces it. If the bound connection is removed,
                the chat explains and stops instead of using another model.
              </Text>
            </PersonaEditorOptions>
            <PersonaEditorOptions phone={phone} title="Media">
              <Text variant="bodySmall">
                This Persona uses the app&apos;s default image workflow.
                Workflow binding appears once ComfyUI workflows are configured;
                until then nothing is substituted.
              </Text>
            </PersonaEditorOptions>
            <Text>
              Profile changes apply to the next response. Current responses keep
              the profile they started with.
            </Text>
            <PersonaEditorOptions phone={phone} title="Avatar and colors">
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
              {!phone ? <Text variant="titleMedium">Appearance</Text> : null}
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
            </PersonaEditorOptions>
            <View style={styles.row}>
              <NativeButton
                accessibilityLabel="Save Persona profile"
                mode="contained"
                onPress={save}
                disabled={busy || !draft.name.trim()}
              >
                {busy ? "Saving..." : "Save profile"}
              </NativeButton>
              <NativeButton
                accessibilityLabel="Cancel Persona profile editing"
                onPress={() =>
                  void perform("Discard a persona profile draft", discardDraft)
                }
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
            mode="contained"
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
                    mode="contained"
                    disabled={busy}
                    onPress={() =>
                      void perform("Start a chat with this persona", async () =>
                        props.onLaunchChat(
                          await props.library.chatIntent(record.id),
                        ),
                      )
                    }
                  >
                    Start chat
                  </NativeButton>
                  {!props.groupUnavailableReason ? (
                    <NativeButton
                      accessibilityLabel={`Add ${record.name} to a group`}
                      disabled={busy || !!props.groupUnavailableReason}
                      onPress={() =>
                        void perform(
                          "Add a persona to a group chat",
                          async () =>
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
                  ) : null}
                  {props.currentConversationId ? (
                    <NativeButton
                      accessibilityLabel={`Use ${record.name} in current chat`}
                      disabled={busy || selectedId === record.id}
                      onPress={() =>
                        void perform(
                          "Use a persona in the current chat",
                          async () => {
                            const intent = await props.library.select(
                              props.currentConversationId!,
                              record.id,
                            );
                            await props.onSwitch?.(intent);
                            await reload();
                          },
                        )
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
              </NativeSurface>
            </ThemeProvider>
          ))}
          {loaded && !error && personas.length === 0 ? (
            <Text>
              No profiles yet. Create a Persona to add your own instructions.
            </Text>
          ) : null}
        </>
      )}
      <Portal>
        <Dialog
          visible={!!deleting}
          dismissable={!busy}
          onDismiss={() => setDeleting(null)}
          style={{ maxHeight: "85%" }}
        >
          <Dialog.Title>
            {deleting ? `Delete ${deleting.name}?` : "Delete Persona?"}
          </Dialog.Title>
          <Dialog.ScrollArea style={{ flexShrink: 1 }}>
            <ScrollView
              contentContainerStyle={{ gap: 12, paddingVertical: 12 }}
            >
              <Text>
                Existing conversations and responses will stay in your library.
              </Text>
              {error ? <ErrorNotice message={error} /> : null}
            </ScrollView>
          </Dialog.ScrollArea>
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

function PersonaEditorOptions({
  phone,
  title,
  children,
}: {
  phone: boolean;
  title: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  if (!phone) return <>{children}</>;
  return (
    <List.Accordion
      title={title}
      accessibilityLabel={`Persona ${title.toLowerCase()} options`}
      style={{ backgroundColor: "transparent" }}
      theme={{ colors: { background: theme.colors.surface } }}
    >
      <View style={{ gap: 12, paddingVertical: 8 }}>{children}</View>
    </List.Accordion>
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
