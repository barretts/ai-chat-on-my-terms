import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Switch, Text } from "react-native-paper";
import {
  NativeButton,
  NativeSurface,
  NativeText,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import {
  completeInitialSync,
  initialSyncPromptVisible,
  optInPairSync,
  optOutPairSync,
  setInitialSyncChoice,
  syncChoicePreviews,
  syncFailureNote,
  syncPreferenceViews,
  syncToggleNote,
  type PairSyncPreference,
  type SyncChoice,
  type SyncPreferenceVault,
} from ".";

export interface SyncPanelProps {
  vault: SyncPreferenceVault;
  /** Paired routes eligible for sync (composition: active pairings only). */
  pairings: () => Promise<readonly { routeId: string; label: string }[]>;
  now: () => string;
  /** Optional live initial copy/merge kick (T098C transport supplies it). */
  runInitialSync?: (routeId: string, choice: SyncChoice) => Promise<string | null>;
  /** Last transport failure surfaced with the SY-08 retry copy. */
  failureNote?: string;
}

export function SyncPanel(props: SyncPanelProps) {
  const { phone } = useWorkspaceLayout();
  const [records, setRecords] = useState<PairSyncPreference[]>([]);
  const [pairingList, setPairingList] = useState<readonly { routeId: string; label: string }[]>([]);
  const [note, setNote] = useState("");

  useEffect(() => {
    void Promise.all([props.vault.load(), props.pairings()]).then(([loaded, list]) => {
      setRecords([...loaded]);
      setPairingList(list);
    });
  }, [props.vault]);

  const rows = syncPreferenceViews(records, pairingList);

  const persist = async (next: PairSyncPreference[]) => {
    setRecords(next);
    await props.vault.save(next);
  };

  const choose = async (routeId: string, choice: SyncChoice) => {
    const picked = setInitialSyncChoice(records, routeId, choice, props.now());
    const failure = (await props.runInitialSync?.(routeId, choice)) ?? null;
    if (failure !== null) {
      // SY-08: keep the choice pending and offer the retry-by-toggle copy.
      await persist(picked);
      setNote(syncFailureNote(failure));
      return;
    }
    await persist(completeInitialSync(picked, routeId, props.now()));
    setNote(syncToggleNote(true));
  };

  const toggle = async (routeId: string, enabled: boolean) => {
    let next: PairSyncPreference[];
    try {
      next = enabled
        ? optInPairSync(records, routeId, props.now())
        : optOutPairSync(records, routeId, props.now());
    } catch {
      return;
    }
    await persist(next);
    setNote(syncToggleNote(enabled));
  };

  return (
    <ScrollView accessibilityLabel="Sync chats panel">
      <View style={{ padding: phone ? 12 : 18, gap: 14 }}>
        <NativeSurface accessibilityLabel="Sync chats with Home Mac">
          <Text variant="titleMedium">Sync chats with Home Mac</Text>
          <NativeText accessibilityLabel="Sync explanation">
            Shared chats sync both ways over your paired connection. Sync is opt-in, and
            turning it off never deletes the chats on either device.
          </NativeText>
          {rows.length === 0 && (
            <NativeText accessibilityLabel="No paired Macs">
              Pair with your desktop first to enable sync.
            </NativeText>
          )}
          {rows.map((row) => (
            <View key={row.routeId} style={{ gap: 6, paddingVertical: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Switch
                  value={row.enabled}
                  onValueChange={(value) => void toggle(row.routeId, value)}
                />
                <NativeText accessibilityLabel={`Sync chats with ${row.label}`}>
                  {row.label} — {row.enabled ? "syncing" : "sync off"}
                </NativeText>
              </View>
              <NativeText accessibilityLabel={`Sync state for ${row.label}`}>
                {row.choiceLabel}
                {row.initialSyncDone ? " · ready" : ""}
              </NativeText>
              {initialSyncPromptVisible(row) && (
                <View style={{ gap: 6 }}>
                  <NativeText accessibilityLabel={`Choose initial sync for ${row.label}`}>
                    How should existing chats line up?
                  </NativeText>
                  {syncChoicePreviews().map((option) => (
                    <View key={option.choice} style={{ gap: 4 }}>
                      <NativeText accessibilityLabel={`Preview ${option.title}`}>
                        {option.preview}
                      </NativeText>
                      <NativeButton
                        accessibilityLabel={`${option.title} for ${row.label}`}
                        onPress={() => void choose(row.routeId, option.choice)}
                      >
                        {option.title}
                      </NativeButton>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
          {note !== "" && <NativeText accessibilityLabel="Sync note">{note}</NativeText>}
          {props.failureNote !== undefined && props.failureNote !== "" && (
            <NativeText accessibilityLabel="Sync failure">
              {syncFailureNote(props.failureNote)}
            </NativeText>
          )}
        </NativeSurface>
      </View>
    </ScrollView>
  );
}
