import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Switch, Text } from "react-native-paper";
import { PairingQrV1Schema } from "@locallab/service-contracts/pairing";
import {
  NativeButton,
  NativeInput,
  NativeSurface,
  NativeText,
  useWorkspaceLayout,
} from "@locallab/ui-native-primitives";
import {
  connectionNote,
  pairedDeviceViews,
  pairingBlockedReason,
  parsePairingScanNote,
  recordFromScan,
  revokeStoredPairing,
  storeStoredPairing,
  type PairedVaultPort,
  type PairingEngine,
  type ScanNote,
  type StoredPairing,
} from ".";

export interface RemotePanelProps {
  /** Builds the sealed-frame engine for one pairing text (device composition). */
  createEngine: (qrText: string) => PairingEngine;
  vault: PairedVaultPort;
  now: () => string;
  /** Optional key rotation (needs native entropy; composition supplies it). */
  rotate?: (routeId: string) => Promise<void>;
}

export function RemotePanel(props: RemotePanelProps) {
  const { phone } = useWorkspaceLayout();
  const [records, setRecords] = useState<StoredPairing[]>([]);
  const [scanText, setScanText] = useState("");
  const [scan, setScan] = useState<ScanNote | null>(null);
  const [consent, setConsent] = useState(false);
  const [engine, setEngine] = useState<PairingEngine | null>(null);
  const [status, setStatus] = useState(connectionNote("idle", ""));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void props.vault.load().then((loaded) => setRecords([...loaded]));
  }, [props.vault]);

  const block = pairingBlockedReason(
    consent,
    scan ?? { kind: "invalid", message: "Scan or paste the pairing code first." },
  );

  const pair = async () => {
    if (scan === null || scan.kind !== "valid" || block !== "") return;
    setBusy(true);
    const next = props.createEngine(scanText);
    setEngine(next);
    setStatus(connectionNote("connecting", ""));
    try {
      await next.connect();
      setStatus(
        `${connectionNote(next.state(), next.note())} Backends: ${next.routes().map((route) => route.label).join(", ")}.`,
      );
      const qr = PairingQrV1Schema.parse(JSON.parse(scanText));
      const saved = storeStoredPairing(records, recordFromScan(qr, scan.summary.host, props.now()));
      await props.vault.save(saved);
      setRecords(saved);
    } catch {
      setStatus(connectionNote(next.state(), next.note()));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    engine?.disconnect();
    setStatus(connectionNote("closed", ""));
  };

  const revoke = async (routeId: string) => {
    const saved = revokeStoredPairing(records, routeId, props.now());
    await props.vault.save(saved);
    setRecords(saved);
    setStatus("Pairing revoked. Show a fresh QR on the desktop to pair again.");
  };

  const rotate = async (routeId: string) => {
    if (props.rotate === undefined) return;
    setBusy(true);
    try {
      await props.rotate(routeId);
      setRecords([...(await props.vault.load())]);
      setStatus("Keys rotated. The old pairing is revoked; scan the new QR if this device reconnects.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView accessibilityLabel="Remote pairing panel">
      <View style={{ padding: phone ? 12 : 18, gap: 14 }}>
        <NativeSurface accessibilityLabel="Pair a desktop">
          <Text variant="titleMedium">Pair with the desktop app</Text>
          <NativeText accessibilityLabel="Pairing help">
            Open the desktop app, choose Connect, and scan its QR (or paste the pairing text).
            This app pairs only with its own desktop app; official LM Mini codes are not supported.
          </NativeText>
          <NativeInput
            accessibilityLabel="Pairing text input"
            label="Pairing text"
            value={scanText}
            onChangeText={(value) => {
              setScanText(value);
              setScan(parsePairingScanNote(value));
            }}
          />
          {scan !== null && scan.kind === "invalid" && (
            <NativeText accessibilityLabel="Invalid pairing code">{scan.message}</NativeText>
          )}
          {scan !== null && scan.kind === "valid" && (
            <NativeText accessibilityLabel="Pairing code recognized">
              Connects through {scan.summary.host} · desktop key …{scan.summary.fingerprintTail}
            </NativeText>
          )}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Switch value={consent} onValueChange={setConsent} />
            <NativeText accessibilityLabel="Share with this desktop">Share with my desktop (opt-in)</NativeText>
          </View>
          {block !== "" && <NativeText accessibilityLabel="Pairing blocked">{block}</NativeText>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <NativeButton accessibilityLabel="Pair now" disabled={block !== "" || busy} onPress={() => void pair()}>
              Pair
            </NativeButton>
            <NativeButton accessibilityLabel="Disconnect" disabled={engine === null} onPress={disconnect}>
              Disconnect
            </NativeButton>
          </View>
          <NativeText accessibilityLabel="Connection status">{status}</NativeText>
        </NativeSurface>

        <NativeSurface accessibilityLabel="Paired devices">
          <Text variant="titleMedium">Paired devices</Text>
          {pairedDeviceViews(records).length === 0 && (
            <NativeText accessibilityLabel="No paired devices">Nothing paired yet.</NativeText>
          )}
          {pairedDeviceViews(records).map((row) => (
            <View key={row.routeId} style={{ gap: 6, paddingVertical: 8 }}>
              <NativeText accessibilityLabel={`Paired ${row.label}`}>
                {row.label} · {row.host} · …{row.fingerprintTail} — {row.status}
              </NativeText>
              {row.status === "active" && (
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <NativeButton
                    accessibilityLabel={`Revoke ${row.label}`}
                    onPress={() => void revoke(row.routeId)}
                  >
                    Revoke
                  </NativeButton>
                  {props.rotate !== undefined && (
                    <NativeButton
                      accessibilityLabel={`Rotate keys for ${row.label}`}
                      disabled={busy}
                      onPress={() => void rotate(row.routeId)}
                    >
                      Rotate keys
                    </NativeButton>
                  )}
                </View>
              )}
            </View>
          ))}
        </NativeSurface>
      </View>
    </ScrollView>
  );
}
