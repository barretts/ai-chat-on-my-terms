import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Switch, Text, useTheme } from "react-native-paper";
import {
  NativeButton,
  NativeSurface,
} from "@locallab/ui-native-primitives";
import type { SpeechOutputPort } from "@locallab/audio-session";
import type { GroupRoomDraft } from "@locallab/groups-config";
import { ErrorNotice } from "../diagnostics/error-notice";
import {
  groupSpeakQueue,
  playGroupSpeakQueue,
  seatWithTools,
  type GroupSpeakStatus,
  type GroupTranscriptEntry,
} from ".";

export interface GroupChatScreenProps {
  room: GroupRoomDraft;
  entries: readonly GroupTranscriptEntry[];
  speech: SpeechOutputPort;
  /** Ask routes one direct request to a participant (manual Ask chip). */
  onAsk: (seatIndex: number) => void;
  /** Per-seat tool permission; never a global toggle (GR-04). */
  onToolsToggle: (participants: GroupRoomDraft["participants"]) => void;
  onScenarioChanged?: (scenario: string) => void;
}

export function GroupChatScreen(props: GroupChatScreenProps) {
  const theme = useTheme();
  const [statuses, setStatuses] = useState<
    ReadonlyMap<number, GroupSpeakStatus>
  >(new Map());
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [participants, setParticipants] = useState(
    () => [...props.room.participants],
  );

  const setSeatStatus = (seatIndex: number, status: GroupSpeakStatus) => {
    setStatuses((current) => {
      const next = new Map(current);
      next.set(seatIndex, status);
      return next;
    });
  };

  const play = async () => {
    setPlaying(true);
    setError("");
    const queue = groupSpeakQueue(participants, props.entries);
    for (const intent of queue) setSeatStatus(intent.seatIndex, { kind: "queued" });
    try {
      await playGroupSpeakQueue(props.speech, queue, setSeatStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPlaying(false);
    }
  };

  const toggleSeatTools = (seatIndex: number, enabled: boolean) => {
    const next = seatWithTools(participants, seatIndex, enabled);
    setParticipants(next);
    props.onToolsToggle(next);
  };

  return (
    <ScrollView style={{ flex: 1 }} accessibilityLabel="Group chat transcript">
      <NativeSurface accessibilityLabel="Group transcript surface">
        {error ? <ErrorNotice message={error} /> : null}
        {props.room.scenario ? (
          <Text variant="titleMedium">{props.room.scenario}</Text>
        ) : null}
        {props.entries.length === 0 ? (
          <Text variant="bodyMedium">
            No replies yet. Ask a participant to start the conversation; the
            turn engine arrives with group scheduling.
          </Text>
        ) : null}
        {props.entries.map((entry) => (
          <View key={entry.id} style={{ marginBottom: 12 }}>
            <Text
              variant="titleSmall"
              style={{ color: entry.accentColor || theme.colors.primary }}
            >
              {entry.speakerName}
            </Text>
            <Text>{entry.text}</Text>
          </View>
        ))}
        <Text variant="titleMedium">Ask a participant</Text>
        {participants.map((seat, seatIndex) => (
          <View
            key={`${seat.displayName}-${seatIndex}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginVertical: 4,
            }}
          >
            <NativeButton
              accessibilityLabel={`Ask ${seat.displayName || "participant"}`}
              disabled={playing}
              onPress={() => props.onAsk(seatIndex)}
            >
              Ask {seat.displayName || `Participant ${seatIndex + 1}`}
            </NativeButton>
            <Text variant="bodySmall" style={{ flex: 1 }}>
              Tools
            </Text>
            <Switch
              accessibilityLabel={`${
                seat.displayName || "Participant"
              } tools switch`}
              value={seat.toolsEnabled}
              disabled={playing}
              onValueChange={(value) => toggleSeatTools(seatIndex, value)}
            />
          </View>
        ))}
        {participants.map((seat, seatIndex) => {
          const status = statuses.get(seatIndex);
          if (!status || status.kind === "idle") return null;
          return status.kind === "failed" ? (
            <ErrorNotice key={`status-${seatIndex}`} message={status.message} />
          ) : (
            <Text key={`status-${seatIndex}`} variant="bodySmall">
              {seat.displayName}: {status.kind === "queued" ? "queued" : "speaking"}
            </Text>
          );
        })}
        <NativeButton
          accessibilityLabel="Play group replies in order"
          disabled={playing || props.entries.length === 0}
          onPress={() => void play()}
        >
          Play replies in order
        </NativeButton>
        <Text variant="bodySmall">
          Each participant keeps its own voice; playback follows the transcript
          order, and a failed voice only marks that participant.
        </Text>
      </NativeSurface>
    </ScrollView>
  );
}
