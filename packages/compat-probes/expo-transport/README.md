# Expo transport compatibility probe

This package isolates the Expo iPhone transport check from chat UI and service code.

- `createExpoProviderPort` in `expo-runtime.ts` uses `expo/fetch` to stream OpenAI-compatible SSE directly to the configured BYOK host. Credentials are resolved when a run starts and are sent in headers. The adapter never writes them to logs, errors, event payloads, or URLs.
- `expoSQLiteRecordProbe` writes a parameterized record, closes its database handle, reopens the same Expo SQLite database, and reads the record through `SQLiteRecordProbePort`.
- `provider.ts` and `sqlite-probe.ts` inject their runtime dependencies so contract tests can cover chunk boundaries, UTF-8 decoding, cancellation, early iterator closure, parameterized writes, and reopen behavior without native services.

The automated checks are bounded fixture evidence. The plan's physical iPhone check remains pending: build the Expo development client, receive a multi-chunk response from a reachable BYOK endpoint, cancel an in-flight response, then force quit/relaunch and verify the SQLite record remains. Record device/build/provider evidence in the coordinator's implementation evidence location.
