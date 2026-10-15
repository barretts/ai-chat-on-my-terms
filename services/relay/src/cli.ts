import { createRelayServer } from "./index.js";

const port = Number(process.env.RELAY_PORT ?? 8790);
const limits = {
  maxConnections: Number(process.env.RELAY_MAX_CONNECTIONS ?? 64),
  messagesPerSecond: Number(process.env.RELAY_MSGS_PER_SEC ?? 100),
  bytesPerSecond: Number(process.env.RELAY_BYTES_PER_SEC ?? 4_194_304),
  highWaterBytes: Number(process.env.RELAY_HIGH_WATER_BYTES ?? 524_288),
  routeTtlMs: Number(process.env.RELAY_ROUTE_TTL_MS ?? 30 * 24 * 60 * 60 * 1000),
  idleTimeoutMs: Number(process.env.RELAY_IDLE_TIMEOUT_MS ?? 30_000),
};

const relay = createRelayServer({
  limits,
  onAudit: (event) => {
    // Routing metadata only; frame payloads never reach this line.
    console.log(JSON.stringify(event));
  },
});

relay.server.listen(port, () => {
  console.log(`locallab relay listening on :${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
