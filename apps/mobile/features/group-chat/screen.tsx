import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Switch, Text, TextInput, useTheme } from "react-native-paper";
import { NativeButton, NativeSurface } from "@locallab/ui-native-primitives";
import type { SpeechOutputPort } from "@locallab/audio-session";
import type {
  GroupReplyDisplay,
  GroupRoomDraft,
} from "@locallab/groups-config";
import { ErrorNotice } from "../diagnostics/error-notice";
import {
  groupSpeakQueue,
  playGroupSpeakQueue,
  seatWithTools,
  type GroupSpeakStatus,
  type GroupTranscriptEntry,
} from ".";

/** Send/Pass/Ask/Stop turn controller (GR-05): one action per tap. */
export interface GroupChatController {
  /** A round is generating seats right now. */
  running: boolean;
  /** Pass only makes sense once the room has content. */
  hasConversation: boolean;
  /** A stored round never finished; input stays locked until a fresh round. */
  staleRound: boolean;
  replyDisplay: GroupReplyDisplay;
  onSend(text: string): void;
  onPass(): void;
  onStop(): void;
  onStartNewRound(): void;
}

/** The seat generating right now; drives the thinking line and live text. */
export interface GroupSeatLive {
  seatIndex: number;
  displayName: string;
  accentColor: string;
  /** Cumulative streamed text; empty in complete-reply mode. */
  text: string;
}

export interface GroupChatScreenProps {
  room: GroupRoomDraft;
  entries: readonly GroupTranscriptEntry[];
  speech: SpeechOutputPort;
  controller: GroupChatController;
  live: GroupSeatLive | null;
  /** Ask routes one direct request to a participant (composer text optional). */
  onAsk: (seatIndex: number, text: string) => void;
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
  const [draft, setDraft] = useState("");
  const [participants, setParticipants] = useState(() => [
    ...props.room.participants,
  ]);
  const { controller, live } = props;
  const locked = controller.running || controller.staleRound;

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
    for (const intent of queue)
      setSeatStatus(intent.seatIndex, { kind: "queued" });
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

  const send = () => {
    const text = draft.trim();
    if (text === "") return;
    setDraft("");
    controller.onSend(text);
  };

  return (
    <ScrollView style={{ flex: 1 }} accessibilityLabel="Group chat transcript">
      <NativeSurface accessibilityLabel="Group transcript surface">
        {error ? <ErrorNotice message={error} /> : null}
        {props.room.scenario ? (
          <Text variant="titleMedium">{props.room.scenario}</Text>
        ) : null}
        {controller.staleRound ? (
          <View accessibilityLabel="Interrupted round notice">
            <Text variant="bodyMedium">
              A previous round did not finish. Completed replies are saved, but
              the unfinished round will not resume automatically.
            </Text>
            <NativeButton
              accessibilityLabel="Start a new round"
              onPress={() => controller.onStartNewRound()}
            >
              Start a new round
            </NativeButton>
          </View>
        ) : null}
        {props.entries.length === 0 && !live ? (
          <Text variant="bodyMedium">
            No replies yet. Send a message to the room, or ask a participant
            directly to start the conversation.
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
        {live ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <Text
              accessibilityLabel={`${live.displayName} avatar`}
              style={{
                color: "#ffffff",
                backgroundColor: live.accentColor || theme.colors.primary,
                borderRadius: 12,
                width: 24,
                height: 24,
                textAlign: "center",
                lineHeight: 24,
              }}
            >
              {(live.displayName.trim()[0] ?? "?").toUpperCase()}
            </Text>
            <Text
              variant="bodySmall"
              style={{ flex: 1 }}
              accessibilityLiveRegion="polite"
            >
              {live.text === ""
                ? `${live.displayName} is thinking…`
                : live.text}
            </Text>
          </View>
        ) : null}
        <TextInput
          label="Message the room"
          placeholder="Send one message; everyone answers in turn…"
          value={draft}
          multiline
          disabled={locked}
          onChangeText={setDraft}
          accessibilityLabel="Group message composer"
        />
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            marginVertical: 8,
          }}
        >
          <NativeButton
            accessibilityLabel="Send message to the room"
            disabled={locked || draft.trim() === ""}
            onPress={send}
          >
            Send
          </NativeButton>
          <NativeButton
            accessibilityLabel="Pass: keep the conversation going"
            disabled={locked || !controller.hasConversation}
            onPress={() => controller.onPass()}
          >
            Pass
          </NativeButton>
          <NativeButton
            accessibilityLabel="Stop the current round"
            disabled={!controller.running}
            onPress={() => controller.onStop()}
          >
            Stop
          </NativeButton>
        </View>
        <Text variant="bodySmall">
          {controller.replyDisplay === "live"
            ? "Replies stream in as each participant generates."
            : "Replies appear when each participant finishes."}
        </Text>
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
              disabled={locked || playing}
              onPress={() => props.onAsk(seatIndex, draft.trim())}
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
              disabled={locked || playing}
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
              {seat.displayName}:{" "}
              {status.kind === "queued" ? "queued" : "speaking"}
            </Text>
          );
        })}
        <NativeButton
          accessibilityLabel="Play group replies in order"
          disabled={playing || locked || props.entries.length === 0}
          onPress={() => void play()}
        >
          Play replies in order
        </NativeButton>
        <Text variant="bodySmall">
          Playback follows the transcript order; each participant speaks with
          its own voice, and a completed reply plays even while a new round
          waits.
        </Text>
      </NativeSurface>
    </ScrollView>
  );
}
