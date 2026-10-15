import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Switch, Text } from "react-native-paper";
import { NativeSurface, NativeText, useWorkspaceLayout } from "@locallab/ui-native-primitives";
import {
  personaSyncOffered,
  personaSyncRows,
  selectPersonas,
  togglePersonaSelection,
  type PersonaListEntry,
  type PersonaSelectionVault,
  type PersonaSyncSelection,
} from ".";

export interface PersonaSyncPairing {
  routeId: string;
  label: string;
  /** Persona opt-in only exists where chat sync is enabled AND chosen. */
  chatSyncEnabled: boolean;
}

export interface PersonaSyncPanelProps {
  vault: PersonaSelectionVault;
  pairings: () => Promise<readonly PersonaSyncPairing[]>;
  personas: () => Promise<readonly PersonaListEntry[]>;
  now: () => string;
}

export function PersonaSyncPanel(props: PersonaSyncPanelProps) {
  const { phone } = useWorkspaceLayout();
  const [selections, setSelections] = useState<PersonaSyncSelection[]>([]);
  const [pairingList, setPairingList] = useState<readonly PersonaSyncPairing[]>([]);
  const [personaList, setPersonaList] = useState<readonly PersonaListEntry[]>([]);

  useEffect(() => {
    void Promise.all([props.vault.load(), props.pairings(), props.personas()]).then(
      ([loaded, pairs, people]) => {
        setSelections([...loaded]);
        setPairingList(pairs);
        setPersonaList(people);
      },
    );
  }, [props.vault]);

  const persist = async (next: PersonaSyncSelection[]) => {
    setSelections(next);
    await props.vault.save(next);
  };

  const togglePersona = async (routeId: string, personaId: string) => {
    await persist(togglePersonaSelection(selections, routeId, personaId, props.now()));
  };

  const setFlags = async (routeId: string, photos: boolean, memories: boolean) => {
    const current = selections.find((row) => row.routeId === routeId);
    await persist(
      selectPersonas(
        selections.filter((row) => row.routeId !== routeId),
        routeId,
        current?.personaIds ?? [],
        { photos, memories },
        props.now(),
      ),
    );
  };

  return (
    <ScrollView accessibilityLabel="Sync characters panel">
      <View style={{ padding: phone ? 12 : 18, gap: 14 }}>
        <NativeSurface accessibilityLabel="Sync selected characters">
          <Text variant="titleMedium">Sync characters</Text>
          <NativeText accessibilityLabel="Character sync explanation">
            Pick which characters, their photos and their facts sync with your paired device.
            Models, voices and keys always stay on each device; anything missing on the other
            side gets a clear prompt instead of a silent substitute.
          </NativeText>
          {pairingList.filter((pair) => personaSyncOffered(pair.chatSyncEnabled)).length === 0 && (
            <NativeText accessibilityLabel="No syncable pairs">
              Turn on chat sync with a paired device first to choose characters.
            </NativeText>
          )}
          {pairingList
            .filter((pair) => personaSyncOffered(pair.chatSyncEnabled))
            .map((pair) => {
              const selection = selections.find((row) => row.routeId === pair.routeId) ?? null;
              return (
                <View key={pair.routeId} style={{ gap: 6, paddingVertical: 8 }}>
                  <NativeText accessibilityLabel={`Character sync for ${pair.label}`}>
                    {pair.label}
                  </NativeText>
                  <View style={{ gap: 4 }}>
                    {personaSyncRows(personaList, selection).map((row) => (
                      <View
                        key={row.personaId}
                        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                      >
                        <Switch
                          value={row.selected}
                          onValueChange={() => void togglePersona(pair.routeId, row.personaId)}
                        />
                        <NativeText accessibilityLabel={`Sync character ${row.name}`}>
                          {row.name}
                          {row.hasPhoto ? " (has photo)" : ""}
                        </NativeText>
                      </View>
                    ))}
                  </View>
                  <View style={{ gap: 4 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Switch
                        value={selection?.photos ?? true}
                        onValueChange={(value) => void setFlags(pair.routeId, value, selection?.memories ?? true)}
                      />
                      <NativeText accessibilityLabel={`Sync photos for ${pair.label}`}>
                        Photos of selected characters
                      </NativeText>
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Switch
                        value={selection?.memories ?? true}
                        onValueChange={(value) => void setFlags(pair.routeId, selection?.photos ?? true, value)}
                      />
                      <NativeText accessibilityLabel={`Sync facts for ${pair.label}`}>
                        Facts tied to selected characters
                      </NativeText>
                    </View>
                  </View>
                </View>
              );
            })}
        </NativeSurface>
      </View>
    </ScrollView>
  );
}
