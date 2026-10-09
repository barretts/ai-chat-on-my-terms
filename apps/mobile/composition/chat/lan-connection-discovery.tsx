import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { ActivityIndicator, List, Text, useTheme } from "react-native-paper";
import { NativeButton, NativeInput } from "@locallab/ui-native-primitives";
import { discoverConnections } from "../../features/connections";
import { providerFetch } from "../../platform/provider-fetch";
import {
  createUnauthenticatedHttpProbe,
  type ProbeResult,
} from "../../../../modules/lan-discovery/src";
import { describeError } from "../../features/diagnostics/errors";
import { ErrorNotice } from "../../features/diagnostics/error-notice";

/** Checks only addresses explicitly entered by the user; never scans a subnet. */
export function LanConnectionDiscovery({
  onChoose,
  onError,
  disabled = false,
}: {
  onChoose(endpoint: string): void;
  onError?(message: string): void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [hosts, setHosts] = useState("");
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const native = Platform.OS === "ios" || Platform.OS === "android";
  const reportFailure = (
    cause: unknown,
    operation: string,
    recovery: string,
  ) => {
    const message = describeError(cause, { operation, recovery });
    setError(message);
    onError?.(message);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  const check = async () => {
    if (!native || disabled || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setResults([]);
    setError("");
    setMessage("Checking your entered addresses…");
    try {
      const candidates = hosts
        .split(/[\s,]+/)
        .map((host) => host.trim())
        .filter(Boolean);
      // discoverConnections caps this at 16 hosts, four concurrent probes and
      // 1.5 seconds per host. The first iOS request triggers its OS prompt.
      const found = await discoverConnections(
        candidates,
        {
          request: async () => (native ? "granted" : "unavailable"),
        },
        createUnauthenticatedHttpProbe((input, init) =>
          providerFetch(input, { ...init, credentials: "omit" }),
        ),
        controller.signal,
      );
      if (!mounted.current) return;
      setResults(found);
      const count = found.filter(
        (result) => result.status !== "not-found",
      ).length;
      if (count)
        setMessage(
          `${count} server${count === 1 ? "" : "s"} found. Choose one to fill in the connection address.`,
        );
      else {
        setMessage("");
        reportFailure(
          new Error(
            `No compatible server responded at ${found.map((item) => item.host).join(", ")}.`,
          ),
          "Check local server addresses",
          "Check the address, port, server LAN access and your phone's Local Network permission, then try again.",
        );
      }
    } catch (cause) {
      if (!mounted.current) return;
      if (controller.signal.aborted)
        setMessage("Address check canceled. You can try again.");
      else {
        setMessage("");
        reportFailure(
          cause,
          "Check local server addresses",
          "Check your entered addresses and Local Network permission, then try again.",
        );
      }
    } finally {
      active.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <View>
      {error && !onError ? <ErrorNotice message={error} /> : null}
      <List.Accordion
        title="Find a local server"
        description="Check known addresses on your Wi-Fi"
        expanded={expanded}
        onPress={() => {
          if (expanded) active.current?.abort();
          setExpanded(!expanded);
        }}
        accessibilityLabel="Find a local server"
        theme={{ colors: { background: theme.colors.surface } }}
        titleStyle={{ fontSize: 15 }}
        style={{ backgroundColor: "transparent" }}
      >
        <View style={{ gap: 12, paddingBottom: 12 }}>
          {native ? (
            <>
              <Text variant="bodyMedium">
                Enter your computer's IP address and port, one per line. Your
                phone and computer must share a network. iOS may ask for Local
                Network access.
              </Text>
              <NativeInput
                label="Server addresses"
                accessibilityLabel="LAN hosts to check"
                value={hosts}
                onChangeText={setHosts}
                placeholder="192.168.1.20:1234"
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                editable={!busy && !disabled}
              />
              <Text variant="bodySmall">
                Up to 16 addresses. No passwords or saved credentials are sent.
              </Text>
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <NativeButton
                  accessibilityLabel="Request permission and scan entered LAN hosts"
                  mode="contained"
                  disabled={busy || disabled || !hosts.trim()}
                  onPress={() => void check()}
                >
                  Check addresses
                </NativeButton>
                {busy ? (
                  <>
                    <ActivityIndicator size="small" />
                    <NativeButton
                      accessibilityLabel="Cancel local server discovery"
                      onPress={() => active.current?.abort()}
                    >
                      Cancel
                    </NativeButton>
                  </>
                ) : null}
              </View>
            </>
          ) : (
            <Text variant="bodyMedium">
              Network discovery works in the iPhone and Android apps. In this
              browser, enter a known server address in Connection settings, then
              choose Find models. On an iPhone, use your computer's Wi-Fi
              address instead of localhost.
            </Text>
          )}
          {message ? (
            <Text accessibilityLiveRegion="polite" variant="bodyMedium">
              {message}
            </Text>
          ) : null}
          {results.map((result) => (
            <View
              key={result.host}
              style={{
                gap: 6,
                paddingVertical: 8,
                borderTopWidth: 1,
                borderTopColor: theme.colors.outlineVariant,
              }}
            >
              <Text variant="titleSmall">{result.host}</Text>
              <Text variant="bodyMedium">
                {result.status === "auth-required"
                  ? "Server found. Add its API key in Connection settings."
                  : result.status === "found"
                    ? result.provider === "lm-studio"
                      ? "LM Studio is available."
                      : "A compatible server is available."
                    : "No compatible server responded."}
              </Text>
              {result.status !== "not-found" ? (
                <NativeButton
                  accessibilityLabel={`Add server at ${result.host}`}
                  disabled={disabled || busy}
                  onPress={() => {
                    try {
                      onChoose(`http://${result.host}/v1`);
                      setExpanded(false);
                    } catch (cause) {
                      reportFailure(
                        cause,
                        "Choose discovered local server",
                        "Enter this server address in Connection settings and try again.",
                      );
                    }
                  }}
                >
                  Use this server
                </NativeButton>
              ) : null}
            </View>
          ))}
        </View>
      </List.Accordion>
    </View>
  );
}
