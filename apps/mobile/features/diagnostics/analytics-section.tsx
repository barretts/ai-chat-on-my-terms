/** Analytics + dashboard settings section (UI-19/DA-04/AR-09). Both
 * consent toggles start OFF; counters shown here come from the device's
 * own trace log, not fixtures. */

import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { traceLog } from "./trace-log";
import {
  createAnalyticsClient,
  createAnalyticsCoordinator,
  type AnalyticsClient,
  type DashboardAggregate,
} from "./analytics";

export function AnalyticsSection(options: {
  baseUrl?: string;
  client?: AnalyticsClient;
}) {
  const client =
    options.client ??
    (options.baseUrl === undefined
      ? undefined
      : createAnalyticsClient({ baseUrl: options.baseUrl }));
  const coordinator = useMemo(
    () => createAnalyticsCoordinator({ ...(client ? { client } : {}) }),
    [client],
  );
  const [consents, setConsents] = useState(coordinator.getConsents());
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [server, setServer] = useState<DashboardAggregate | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void coordinator.loadConsents().then(() => {
      setConsents(coordinator.getConsents());
    });
    const sync = () => {
      // Feed real trace data into the local counters.
      coordinator.recordTrace(traceLog.getSnapshot());
      setCounters(coordinator.localSnapshot().counters);
    };
    sync();
    return traceLog.subscribe(sync);
  }, [coordinator]);

  async function toggle(kind: "product" | "benchmark") {
    await coordinator.setConsent(kind, !consents[kind]);
    setConsents(coordinator.getConsents());
  }

  async function send() {
    const sent = await coordinator.flushAnalytics();
    setMessage(
      sent === 0 ? "Nothing to send (consent off or empty)." : `Sent ${sent}.`,
    );
  }

  async function refreshServer() {
    if (client === undefined) {
      setMessage("No metrics endpoint is configured.");
      return;
    }
    try {
      setServer(await client.dashboard());
    } catch {
      setMessage("Server dashboard unavailable.");
    }
  }

  return (
    <View style={styles.row} testID="analytics-section">
      <Text style={styles.title}>Analytics</Text>
      <Text style={styles.muted}>
        Anonymous product and benchmark metrics are off until you turn
        them on. Chat text, prompts and keys are never collected.
      </Text>
      <Pressable
        onPress={() => void toggle("product")}
        testID="analytics-consent-product"
        style={styles.toggle}
      >
        <Text>
          Anonymous product analytics: {consents.product ? "on" : "off"}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => void toggle("benchmark")}
        testID="analytics-consent-benchmark"
        style={styles.toggle}
      >
        <Text>
          Anonymous benchmark sharing: {consents.benchmark ? "on" : "off"}
        </Text>
      </Pressable>
      <View style={styles.actions}>
        <Pressable onPress={() => void send()} testID="analytics-send">
          <Text>Send now</Text>
        </Pressable>
        <Pressable
          onPress={() => void refreshServer()}
          testID="analytics-refresh"
        >
          <Text>Refresh server dashboard</Text>
        </Pressable>
      </View>
      <Text style={styles.muted}>Local counters (from this device):</Text>
      {Object.entries(counters).map(([name, value]) => (
        <Text key={name} testID={`analytics-counter-${name}`}>
          {name}: {value}
        </Text>
      ))}
      {server === null ? null : (
        <View testID="analytics-server-dashboard">
          <Text style={styles.muted}>Server dashboard:</Text>
          {Object.entries(server.eventCounts).map(([name, value]) => (
            <Text key={name} testID={`analytics-event-${name}`}>
              {name}: {value}
            </Text>
          ))}
          {Object.entries(server.errorCodeCounts).map(([code, value]) => (
            <Text key={code} testID={`analytics-error-${code}`}>
              errors · {code}: {value}
            </Text>
          ))}
        </View>
      )}
      {message !== null ? <Text style={styles.error}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingVertical: 12 },
  title: { fontWeight: "600" },
  toggle: { paddingVertical: 4 },
  actions: { flexDirection: "row", gap: 12 },
  muted: { opacity: 0.6 },
  error: { color: "#b00020" },
});
