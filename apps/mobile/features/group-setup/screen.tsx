import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Text, TextInput } from "react-native-paper";
import {
  NativeButton,
  NativeDropdown,
  NativeSurface,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import {
  SQLiteGroupConfigStore,
  emptyGroupParticipant,
  validateGroupRoom,
  type GroupRoomDraft,
  type GroupValidationError,
} from "@locallab/groups-config";
import type {
  PersonaGroupIntent,
  PersonaLibraryPort,
  PersonaRecord,
} from "@locallab/personas-library";
import { ErrorNotice } from "../diagnostics/error-notice";
import type { PersonaModelConnectionOption } from "../persona-bindings";
import {
  directModelSeat,
  groupSeatChoices,
  newGroupRoomDraft,
  personaSeatFromIntent,
} from ".";

export interface GroupSetupPanelProps {
  store: SQLiteGroupConfigStore;
  library: PersonaLibraryPort;
  connections: readonly PersonaModelConnectionOption[];
  conversationId: string;
  createId: () => string;
  /** "Add to group" pressed in the Personas panel; seats the Persona once. */
  pendingSeat: PersonaGroupIntent | null;
  onPendingSeatConsumed: () => void;
  onRoomSaved?: (roomId: string) => void;
  /** "Open" pressed on a saved room; enters the group chat screen. */
  onOpenRoom?: (roomId: string) => void;
}

export function GroupSetupPanel(props: GroupSetupPanelProps) {
  const { phone } = useWorkspaceLayout();
  const [draft, setDraft] = useState<GroupRoomDraft>(() =>
    newGroupRoomDraft(props.conversationId),
  );
  const [personas, setPersonas] = useState<PersonaRecord[]>([]);
  const [roomChoices, setRoomChoices] = useState<
    { value: string; label: string }[]
  >([]);
  const [errors, setErrors] = useState<GroupValidationError[]>([]);
  const [savedNote, setSavedNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([props.library.list(), props.store.listRooms()])
      .then(([records, rooms]) => {
        if (!active) return;
        setPersonas(records);
        setRoomChoices(
          rooms.map((room) => ({ value: room.id, label: room.name })),
        );
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    return () => {
      active = false;
    };
  }, [props.library, props.store]);

  useEffect(() => {
    if (!props.pendingSeat) return;
    setDraft((current) => ({
      ...current,
      participants: [
        ...current.participants,
        personaSeatFromIntent(props.pendingSeat!),
      ],
    }));
    setSavedNote("");
    props.onPendingSeatConsumed();
  }, [props.pendingSeat, props.onPendingSeatConsumed]);

  const seatChoices = groupSeatChoices(
    personas.map((persona) => ({ id: persona.id, name: persona.name })),
    props.connections,
  );

  const addSeat = (choice: string) => {
    if (!choice) return;
    const kind = choice.slice(0, choice.indexOf(":"));
    const targetId = choice.slice(choice.indexOf(":") + 1);
    setDraft((current) => {
      if (kind === "persona") {
        const persona = personas.find((record) => record.id === targetId);
        if (!persona) return current;
        return {
          ...current,
          participants: [
            ...current.participants,
            {
              ...emptyGroupParticipant(),
              personaId: persona.id,
              displayName: persona.name,
            },
          ],
        };
      }
      const connection = props.connections.find(
        (record) => record.id === targetId,
      );
      if (!connection) return current;
      return {
        ...current,
        participants: [...current.participants, directModelSeat(connection)],
      };
    });
    setErrors([]);
    setSavedNote("");
  };

  const patchSeat = (
    index: number,
    patch: Partial<GroupRoomDraft["participants"][number]>,
  ) => {
    setDraft((current) => ({
      ...current,
      participants: current.participants.map((seat, seatIndex) =>
        seatIndex === index ? { ...seat, ...patch } : seat,
      ),
    }));
    setErrors([]);
  };

  const removeSeat = (index: number) => {
    setDraft((current) => ({
      ...current,
      participants: current.participants.filter(
        (_, seatIndex) => seatIndex !== index,
      ),
    }));
    setErrors([]);
  };

  const openRoom = async (roomId: string) => {
    if (!roomId) return;
    setBusy(true);
    setError("");
    try {
      const loaded = await props.store.loadRoom(roomId);
      if (loaded) {
        setDraft(loaded);
        setErrors([]);
        setSavedNote("Reopened this room with every participant binding.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const problems = await validateGroupRoom(draft, {
        findConnection: async (connectionId) => {
          const connection = props.connections.find(
            (record) => record.id === connectionId,
          );
          return connection
            ? { id: connection.id, modelId: connection.modelId }
            : undefined;
        },
        findPersona: async (personaId) => {
          const record = await props.library.get(personaId);
          return record ? { id: record.id } : undefined;
        },
      });
      if (problems.length) {
        setErrors(problems);
        setSavedNote("");
        return;
      }
      const roomId = await props.store.saveRoom(draft, props.createId);
      setDraft((current) => ({ ...current, id: roomId }));
      setRoomChoices((current) =>
        current.some((choice) => choice.value === roomId)
          ? current
          : [...current, { value: roomId, label: draft.name || "Group chat" }],
      );
      setErrors([]);
      setSavedNote(
        "Group saved. Every participant binding is valid. Open the room below to chat with it.",
      );
      props.onRoomSaved?.(roomId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const errorsFor = (index: number) =>
    errors.filter((problem) => problem.participantIndex === index);

  return (
    <ScrollView style={{ flex: 1 }} accessibilityLabel="Group setup panel">
      <NativeSurface accessibilityLabel="Group setup surface">
        {error ? <ErrorNotice message={error} /> : null}
        {errors.some((problem) => problem.participantIndex === null) ? (
          <ErrorNotice
            message={errors
              .filter((problem) => problem.participantIndex === null)
              .map((problem) => problem.message)
              .join("\n")}
          />
        ) : null}
        {savedNote ? <Text variant="bodyMedium">{savedNote}</Text> : null}
        <NativeDropdown
          label="Saved group rooms"
          value=""
          options={roomChoices}
          emptyText="No saved groups yet."
          disabled={busy}
          onChange={(roomId) => void openRoom(roomId)}
        />
        {props.onOpenRoom && roomChoices.length > 0 ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              marginVertical: 8,
            }}
          >
            {roomChoices.map((room) => (
              <NativeButton
                key={room.value}
                accessibilityLabel={`Open group ${room.label}`}
                disabled={busy}
                onPress={() => props.onOpenRoom?.(room.value)}
              >
                Open {room.label}
              </NativeButton>
            ))}
          </View>
        ) : null}
        <TextInput
          label="Group name"
          accessibilityLabel="Group name"
          value={draft.name}
          onChangeText={(name) => setDraft({ ...draft, name })}
          disabled={busy}
        />
        <TextInput
          label="Room scenario (what is this group for?)"
          accessibilityLabel="Room scenario"
          value={draft.scenario}
          multiline
          onChangeText={(scenario) => setDraft({ ...draft, scenario })}
          disabled={busy}
        />
        <TextInput
          label="Your display name in this room"
          accessibilityLabel="Your display name"
          value={draft.userDisplayName}
          onChangeText={(userDisplayName) =>
            setDraft({ ...draft, userDisplayName })
          }
          disabled={busy}
        />
        {!phone ? <Text variant="titleMedium">Participants</Text> : null}
        {draft.participants.map((seat, index) => (
          <View key={`${draft.id ?? "new"}-${index}`}>
            <TextInput
              label={`Participant ${index + 1} name`}
              accessibilityLabel={`Participant ${index + 1} name`}
              value={seat.displayName}
              onChangeText={(displayName) => patchSeat(index, { displayName })}
              disabled={busy}
            />
            {seat.personaId ? (
              <Text variant="bodySmall">
                Persona seat: {seat.displayName || "unnamed"}
              </Text>
            ) : (
              <Text variant="bodySmall">
                Direct model: {seat.modelId ?? "unknown"}
              </Text>
            )}
            <TextInput
              label={`Participant ${index + 1} system prompt`}
              accessibilityLabel={`Participant ${index + 1} system prompt`}
              value={seat.systemPrompt}
              multiline
              onChangeText={(systemPrompt) =>
                patchSeat(index, { systemPrompt })
              }
              disabled={busy}
            />
            {errorsFor(index).map((problem) => (
              <Text key={problem.message} variant="bodySmall">
                {problem.message}
              </Text>
            ))}
            <NativeButton
              accessibilityLabel={`Remove participant ${index + 1}`}
              disabled={busy}
              onPress={() => removeSeat(index)}
            >
              Remove participant
            </NativeButton>
          </View>
        ))}
        <NativeDropdown
          label="Add participant"
          value=""
          options={seatChoices}
          emptyText="Save a Persona or a connection first."
          disabled={busy}
          onChange={addSeat}
        />
        <NativeButton
          accessibilityLabel="Validate and save group"
          disabled={busy}
          onPress={() => void save()}
        >
          Validate and save group
        </NativeButton>
        <Text variant="bodySmall">
          A model removed from Connections or a deleted Persona blocks the save
          with a per-participant message; nothing is replaced automatically. One
          model can hold several seats with different system prompts.
        </Text>
      </NativeSurface>
    </ScrollView>
  );
}
