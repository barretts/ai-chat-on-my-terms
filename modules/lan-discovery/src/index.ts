/** User initiated, permission gated and bounded discovery for LAN model servers. */
export type LanPermission = "granted" | "denied" | "unavailable";

export interface LanDiscoveryPermissionPort {
  request(): Promise<LanPermission>;
}

export interface LanProbePort {
  /** Must make an unauthenticated request. Scans must never receive secret refs. */
  probe(host: string, signal: AbortSignal): Promise<ProbeResult>;
}

export type ProbeResult =
  | {
      status: "found";
      host: string;
      provider: "lm-studio" | "openai-compatible";
    }
  | { status: "auth-required"; host: string }
  | { status: "not-found"; host: string };

export interface DiscoveryOptions {
  hosts: readonly string[];
  permission: LanDiscoveryPermissionPort;
  probe: LanProbePort;
  /** Caps caller supplied candidates before any network request. */
  maxHosts?: number;
  timeoutMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_HOSTS = 16;
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_CONCURRENCY = 4;

/**
 * Scans only explicitly supplied hosts, only after a platform permission
 * prompt, with a strict candidate, timeout and concurrency bound. It has no
 * credential parameter by design: protected servers are returned as
 * auth-required after a 401/403 and can then be added manually.
 */
export async function discoverLanServers(
  options: DiscoveryOptions,
): Promise<ProbeResult[]> {
  const maxHosts = boundedInteger(
    options.maxHosts ?? DEFAULT_MAX_HOSTS,
    1,
    64,
    "maxHosts",
  );
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    100,
    5_000,
    "timeoutMs",
  );
  const concurrency = boundedInteger(
    options.concurrency ?? DEFAULT_CONCURRENCY,
    1,
    8,
    "concurrency",
  );
  const hosts = [...new Set(options.hosts.map(normalizeManualHost))];
  if (hosts.length === 0)
    throw new Error("Enter at least one LAN host to scan");
  if (hosts.length > maxHosts)
    throw new Error(`Discovery is limited to ${maxHosts} hosts per scan`);
  if (options.signal?.aborted)
    throw new DOMException("Discovery canceled", "AbortError");
  const permission = await options.permission.request();
  if (permission !== "granted")
    throw new Error(
      permission === "denied"
        ? "Local network permission is required"
        : "Local network discovery is unavailable on this device",
    );
  if (options.signal?.aborted)
    throw new DOMException("Discovery canceled", "AbortError");

  const results: ProbeResult[] = new Array(hosts.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < hosts.length) {
      if (options.signal?.aborted)
        throw new DOMException("Discovery canceled", "AbortError");
      const index = cursor++;
      const host = hosts[index]!;
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      let rejectTimeout!: (reason: Error) => void;
      const timeoutFailure = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
      });
      const timeout = setTimeout(() => {
        const reason = new Error("Discovery probe timed out");
        controller.abort(reason);
        rejectTimeout(reason);
      }, timeoutMs);
      try {
        results[index] = await Promise.race([
          options.probe.probe(host, controller.signal),
          timeoutFailure,
        ]);
      } catch {
        if (options.signal?.aborted)
          throw new DOMException("Discovery canceled", "AbortError");
        results[index] = { status: "not-found", host };
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, hosts.length) }, worker),
  );
  return results;
}

/** Accept one explicit IPv4/IPv6 literal or DNS host, never a URL with credentials/path. */
export function normalizeManualHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\s/@?#]/.test(trimmed) || trimmed.includes("\\"))
    throw new Error("Enter a host name or IP address without a path");
  const url = new URL(`http://${trimmed}`);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter a host name or IP address without credentials or a path",
    );
  const host = url.host.toLowerCase();
  if (!url.hostname || host.length > 260) throw new Error("Invalid host");
  return host;
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

/** Fetch adapter: discovery calls only public model endpoints and never attaches configured headers. */
export function createUnauthenticatedHttpProbe(
  fetcher: typeof fetch,
): LanProbePort {
  return {
    async probe(host, signal) {
      const base = `http://${host}`;
      for (const path of ["/api/v0/models", "/v1/models"]) {
        try {
          const response = await fetcher(`${base}${path}`, {
            method: "GET",
            signal,
            redirect: "manual",
            headers: { Accept: "application/json" },
          });
          if (response.status === 401 || response.status === 403)
            return { status: "auth-required", host };
          if (!response.ok) continue;
          const provider =
            path === "/api/v0/models" ? "lm-studio" : "openai-compatible";
          return { status: "found", host, provider };
        } catch {
          if (signal.aborted)
            throw new DOMException("Discovery canceled", "AbortError");
        }
      }
      return { status: "not-found", host };
    },
  };
}
