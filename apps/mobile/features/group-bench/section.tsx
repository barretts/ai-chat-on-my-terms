/**
 * T180 developer benchmark section: runs the T179 row-3 matrix over the
 * real group runtime and shares the JSON manifest. Mounted unconditionally
 * in Settings (T181 owner request); after an app crash the "-partial"
 * checkpoint from the last run stays shareable from this section.
 */

import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { setStringAsync } from "expo-clipboard";
import { shareAsync } from "expo-sharing";
import { listInstalledModels } from "../../platform/model-download";
import {
  buildBenchMatrix,
  type BenchManifest,
  type BenchScenarioRecord,
} from "./matrix";
import {
  listBenchManifests,
  createBenchSession,
  type BenchSession,
} from "./runner";

const LIMIT_CHOICES = [64, 128, 256] as const;

type LimitChoice = (typeof LIMIT_CHOICES)[number];

function nextLimit(current: LimitChoice): LimitChoice {
  return current === 64 ? 128 : current === 128 ? 256 : 64;
}

export function DevBenchSection() {
  const [models, setModels] = useState<
    { catalogId: string; blobId: string; name: string }[]
  >([]);
  const [selectedBlobIds, setSelectedBlobIds] = useState<string[]>([]);
  const [rounds, setRounds] = useState("2");
  const [limit, setLimit] = useState<(typeof LIMIT_CHOICES)[number]>(128);
  const [status, setStatus] = useState<
    "idle" | "running" | "done" | "stopped" | "error"
  >("idle");
  const [progress, setProgress] = useState("");
  const [lastFile, setLastFile] = useState<{
    fileName: string;
    uri: string;
  } | null>(null);
  const [existingFile, setExistingFile] = useState<{
    fileName: string;
    uri: string;
  } | null>(null);
  const lastManifestRef = useRef<BenchManifest | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<BenchSession | null>(null);

  useEffect(() => {
    void listInstalledModels()
      .then(setModels)
      .catch(() => setModels([]));
    setExistingFile(listBenchManifests()[0] ?? null);
    return () => {
      abortRef.current?.abort();
      void sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, []);

  function toggleModel(blobId: string) {
    setSelectedBlobIds((current) =>
      current.includes(blobId)
        ? current.filter((id) => id !== blobId)
        : [...current, blobId],
    );
  }

  async function run() {
    if (status === "running" || selectedBlobIds.length === 0) return;
    const roundsPerScenario = Math.min(
      5,
      Math.max(1, Number.parseInt(rounds, 10) || 2),
    );
    setRounds(String(roundsPerScenario));
    setProgress("Opening services…");
    setStatus("running");
    setLastFile(null);
    lastManifestRef.current = null;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const session = await createBenchSession();
      sessionRef.current = session;
      const plans = buildBenchMatrix(
        selectedBlobIds.map((blobId) => `blob:${blobId}`),
      );
      const collected: BenchScenarioRecord[] = [];
      const outcome = await session.run({
        plans,
        roundsPerScenario,
        responseLimitTokens: limit,
        signal: controller.signal,
        onProgress: (done, total, label) =>
          setProgress(`Scenario ${done + 1}/${total}: ${label}`),
        onRoundDone: (done, total, label, round, roundsTotal) =>
          setProgress(
            `Scenario ${done + 1}/${total}: ${label} — round ${round}/${roundsTotal} done`,
          ),
        onScenarioDone: (scenario) => {
          collected.push(scenario);
          // Crash-proof: rewrite the on-disk copy after every scenario.
          try {
            session.writeCheckpoint(
              session.manifestFor(
                { scenarios: collected, stopped: false },
                { roundsPerScenario, responseLimitTokens: limit },
              ),
            );
          } catch {
            /* checkpoint is best-effort */
          }
        },
      });
      const manifest = session.manifestFor(outcome, {
        roundsPerScenario,
        responseLimitTokens: limit,
      });
      lastManifestRef.current = manifest;
      const saved = await session.writeAndShareManifest(manifest);
      setLastFile(saved);
      setProgress(
        outcome.stopped
          ? `Stopped at ${outcome.scenarios.length}/${plans.length} scenarios.`
          : `Complete: ${outcome.scenarios.length} scenarios.`,
      );
      setStatus(outcome.stopped ? "stopped" : "done");
    } catch (error) {
      setProgress(
        `Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      setStatus("error");
    } finally {
      await sessionRef.current?.dispose();
      sessionRef.current = null;
      abortRef.current = null;
    }
  }

  async function stop() {
    abortRef.current?.abort();
    // The active round keeps its completed replies; in-flight seats cancel.
    const current = sessionRef.current;
    if (current) setProgress("Stopping after the current seat…");
  }

  return (
    <View style={styles.row} testID="dev-bench-section">
      <Text style={styles.title}>Developer benchmark</Text>
      <Text style={styles.help}>
        Runs the T179 group matrix (seats 2/3/5 x round-robin/dice/
        topic-interest) on the selected installed models, then shares a JSON
        manifest. Rooms are deleted after each scenario.
      </Text>
      {models.length === 0 ? (
        <Text style={styles.help} testID="dev-bench-no-models">
          No installed GGUF models found. Download models first.
        </Text>
      ) : (
        models.map((model) => (
          <Pressable
            key={model.blobId}
            onPress={() => toggleModel(model.blobId)}
            testID={`dev-bench-model-${model.catalogId.replace(/[^a-z0-9]/gi, "-")}`}
          >
            <Text style={styles.model}>
              {selectedBlobIds.includes(model.blobId) ? "[x] " : "[ ] "}
              {model.name}
            </Text>
          </Pressable>
        ))
      )}
      <View style={styles.controls}>
        <Text style={styles.help}>Rounds/scenario:</Text>
        <TextInput
          value={rounds}
          onChangeText={setRounds}
          keyboardType="number-pad"
          style={styles.input}
          testID="dev-bench-rounds"
        />
        <Pressable
          onPress={() => setLimit(nextLimit(limit))}
          testID="dev-bench-limit"
        >
          <Text style={styles.model}>Reply cap: {limit} tokens</Text>
        </Pressable>
      </View>
      <View style={styles.controls}>
        {status === "running" ? (
          <Pressable onPress={() => void stop()} testID="dev-bench-stop">
            <Text style={styles.action}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => void run()} testID="dev-bench-run">
            <Text style={styles.action}>Run matrix</Text>
          </Pressable>
        )}
        {lastFile !== null ? (
          <>
            <Pressable
              onPress={() => void shareAsync(lastFile.uri)}
              testID="dev-bench-share"
            >
              <Text style={styles.action}>Share {lastFile.fileName}</Text>
            </Pressable>
            <Pressable
              onPress={() =>
                void setStringAsync(
                  JSON.stringify(lastManifestRef.current ?? {}, null, 2),
                )
              }
              testID="dev-bench-copy"
            >
              <Text style={styles.action}>Copy manifest</Text>
            </Pressable>
          </>
        ) : null}
        {lastFile === null && existingFile !== null ? (
          <Pressable
            onPress={() => void shareAsync(existingFile.uri)}
            testID="dev-bench-share-last"
          >
            <Text style={styles.action}>Share {existingFile.fileName}</Text>
          </Pressable>
        ) : null}
      </View>
      {progress !== "" ? (
        <Text style={styles.progress} testID="dev-bench-progress">
          {progress}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 12, gap: 8 },
  title: { fontSize: 16, fontWeight: "600" },
  help: { opacity: 0.7 },
  model: { paddingVertical: 6 },
  controls: { flexDirection: "row", alignItems: "center", gap: 16 },
  input: { width: 48, borderWidth: 1, padding: 4, textAlign: "center" },
  action: { fontSize: 15, fontWeight: "600", paddingVertical: 6 },
  progress: { fontStyle: "italic" },
});
