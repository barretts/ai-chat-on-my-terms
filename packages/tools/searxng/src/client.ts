import { normalizeSearxngBaseUrl, type SearxngConfig } from "./config";
import { SearxngError } from "./errors";

/** One kept search result. {@link title} is sanitized and bounded to 200
 * characters; {@link text} is sanitized and bounded by maxTextBytes on
 * whole character boundaries. */
export interface SearxngResult {
  title: string;
  url: string;
  text: string;
  /** Engine name, present when the server reports one. */
  engine?: string;
  /** Engine score, present when the server reports one. */
  score?: number;
}

/** One successful search: kept results in server order plus the count of
 * entries dropped by normalization. Nothing is discarded silently. */
export interface SearxngSearchOutcome {
  results: SearxngResult[];
  dropped: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 20;
const DEFAULT_MAX_TEXT_BYTES = 4_000;
const MAX_TEXT_BYTES_CAP = 8_000;
const MAX_TITLE_CHARS = 200;
const MAX_REDIRECT_HOPS = 5;

/** What the instance operator must do; quoted verbatim so the string also
 * appears in the "format is disabled" explanations. */
const JSON_FORMAT_HINT =
  'the instance must enable "format=json" in its settings.yml ' +
  "(settings.formats) to answer JSON API requests";

/** Replaces control characters with spaces, trims, and (when maxChars is
 * given) keeps at most that many whole characters. */
function sanitizeText(value: string, maxChars?: number): string {
  let text = "";
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0xfffd;
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f) || point === 0x2028 || point === 0x2029)
      text += " ";
    else text += char;
  }
  if (maxChars !== undefined) text = [...text].slice(0, maxChars).join("");
  return text.trim();
}

/** Truncates at whole characters so the UTF-8 encoding never exceeds
 * maxBytes. */
function truncateTextBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const encoder = new TextEncoder();
  let kept = "";
  let used = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (used + size > maxBytes) break;
    used += size;
    kept += char;
  }
  return kept;
}

/**
 * JSON-API client for a configured SearXNG instance:
 * `GET {baseUrl}/search?q=...&format=json[&language=][&categories=]`.
 *
 * Security policy (mirrors the mcp-http precedent): every request is issued
 * with `redirect: "manual"`. Configured headers are attached only while the
 * effective request URL keeps the configured origin; same-origin redirects
 * are followed up to 5 hops, cross-origin redirects are refused with an
 * "unsupported" {@link SearxngError} and the foreign origin is never
 * contacted.
 */
export class SearxngClient {
  readonly config: SearxngConfig;
  private readonly base: URL;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: SearxngConfig, opts: { fetch?: typeof globalThis.fetch } = {}) {
    this.config = config;
    this.base = new URL(normalizeSearxngBaseUrl(config.baseUrl));
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  /** Runs one search. An empty result list is a SUCCESS (valid "no hits"
   * answer), never an error. Every failure is a {@link SearxngError} with a
   * code from the honest classification rules. */
  async search(query: string, signal: AbortSignal): Promise<SearxngSearchOutcome> {
    const params = new URLSearchParams();
    params.set("q", query);
    params.set("format", "json");
    if (this.config.language !== undefined) params.set("language", this.config.language);
    if (this.config.categories !== undefined) params.set("categories", this.config.categories);

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let aborted = signal.aborted;
    signal.addEventListener("abort", () => (aborted = true), { once: true });
    const deadline = AbortSignal.timeout(timeoutMs);
    deadline.addEventListener("abort", () => (timedOut = true), { once: true });

    let response: Response;
    try {
      response = await this.fetchSearch(params, deadline, signal);
    } catch (cause) {
      if (timedOut)
        throw new SearxngError(
          "timeout",
          `The SearXNG request to "${this.base.origin}" exceeded ${timeoutMs} ms.`,
        );
      if (aborted)
        throw new SearxngError("canceled", "The SearXNG request was canceled.");
      if (cause instanceof SearxngError) throw cause;
      if (
        (cause instanceof Error || cause instanceof DOMException) &&
        cause.name === "AbortError"
      )
        throw new SearxngError("canceled", "The SearXNG request was canceled.");
      throw new SearxngError(
        "offline",
        `Could not reach the SearXNG instance at "${this.base.origin}": ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }

    try {
      return await this.readOutcome(response);
    } catch (cause) {
      if (cause instanceof SearxngError) throw cause;
      if (timedOut)
        throw new SearxngError(
          "timeout",
          `The SearXNG response body from "${this.base.origin}" exceeded ${timeoutMs} ms.`,
        );
      if (aborted)
        throw new SearxngError("canceled", "The SearXNG request was canceled.");
      throw new SearxngError(
        "malformed",
        `Could not read the SearXNG response body from "${this.base.origin}": ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  /** GETs with manual redirects: same-origin hops are followed (headers
   * forwarded) up to MAX_REDIRECT_HOPS; a cross-origin hop is refused
   * without ever contacting the foreign origin. */
  private async fetchSearch(
    params: URLSearchParams,
    deadline: AbortSignal,
    caller: AbortSignal,
  ): Promise<Response> {
    const searchPath =
      this.base.pathname === "/"
        ? "/search"
        : `${this.base.pathname}/search`;
    let target = new URL(`${searchPath}?${params}`, this.base);
    const controller = new AbortController();
    if (deadline.aborted) controller.abort(deadline.reason);
    if (caller.aborted) controller.abort(caller.reason);
    deadline.addEventListener("abort", () => controller.abort(deadline.reason), { once: true });
    caller.addEventListener("abort", () => controller.abort(caller.reason), { once: true });
    for (let hop = 0; ; hop += 1) {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.config.headers && target.origin === this.base.origin) {
        for (const [name, value] of Object.entries(this.config.headers))
          headers[name] = value;
      }
      const response = await this.fetchImpl(target.href, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) return response;
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location)
        throw new SearxngError(
          "malformed",
          `The SearXNG instance at "${this.base.origin}" answered HTTP ${response.status} ` +
            "without a Location header.",
        );
      const next = new URL(location, target);
      if (next.origin !== this.base.origin)
        throw new SearxngError(
          "unsupported",
          `The SearXNG instance at "${this.base.origin}" redirected the search to a ` +
            `foreign origin (${next.origin}); configured credentials were not sent ` +
            "and the redirect was refused.",
        );
      if (hop >= MAX_REDIRECT_HOPS)
        throw new SearxngError(
          "malformed",
          `The SearXNG instance at "${this.base.origin}" exceeded ${MAX_REDIRECT_HOPS} ` +
            "same-origin redirect hops.",
        );
      target = next;
    }
  }

  /** Maps the HTTP answer and JSON body onto results + dropped counts, or
   * throws the classified SearxngError. */
  private async readOutcome(response: Response): Promise<SearxngSearchOutcome> {
    const contentType = ((response.headers.get("content-type") ?? "")
      .split(";", 1)[0] ?? "")
      .trim()
      .toLowerCase();
    if (response.status === 401 || response.status === 403) {
      if (contentType === "text/html")
        throw new SearxngError(
          "unsupported",
          `The SearXNG instance at "${this.base.origin}" answered HTTP ${response.status} ` +
            `with an HTML page; the JSON API format is disabled: ${JSON_FORMAT_HINT}.`,
        );
      throw new SearxngError(
        "auth",
        `The SearXNG instance at "${this.base.origin}" rejected the request with HTTP ` +
          `${response.status}; check the configured authentication headers.`,
      );
    }
    if (response.status === 429)
      throw new SearxngError(
        "ratelimited",
        `The SearXNG instance at "${this.base.origin}" rate-limited the request (HTTP 429).`,
      );
    if (response.status < 200 || response.status >= 300)
      throw new SearxngError(
        "malformed",
        `The SearXNG instance at "${this.base.origin}" answered HTTP ${response.status}.`,
      );
    if (contentType === "text/html")
      throw new SearxngError(
        "unsupported",
        `The SearXNG instance at "${this.base.origin}" answered HTTP 200 with an HTML ` +
          `page; the JSON API format is disabled: ${JSON_FORMAT_HINT}.`,
      );
    const body = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new SearxngError(
        "malformed",
        `The SearXNG instance at "${this.base.origin}" returned invalid JSON.`,
      );
    }
    const payloadObject: Record<string, unknown> =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    if (!Array.isArray(payloadObject.results))
      throw new SearxngError(
        "malformed",
        `The SearXNG response from "${this.base.origin}" has no "results" array.`,
      );
    const maxResults = Math.min(this.config.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);
    const maxTextBytes = Math.min(
      this.config.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
      MAX_TEXT_BYTES_CAP,
    );
    const results: SearxngResult[] = [];
    let dropped = 0;
    for (const [index, entry] of payloadObject.results.entries()) {
      if (typeof entry !== "object" || entry === null) {
        dropped += 1;
        continue;
      }
      const raw = entry as Record<string, unknown>;
      if (typeof raw.url !== "string") {
        dropped += 1;
        continue;
      }
      let protocol: string;
      try {
        protocol = new URL(raw.url).protocol;
      } catch {
        dropped += 1;
        continue;
      }
      if (protocol !== "http:" && protocol !== "https:") {
        dropped += 1;
        continue;
      }
      const title = typeof raw.title === "string" ? sanitizeText(raw.title, MAX_TITLE_CHARS) : "";
      if (title === "") {
        dropped += 1;
        continue;
      }
      const text = truncateTextBytes(
        sanitizeText(typeof raw.content === "string" ? raw.content : ""),
        maxTextBytes,
      );
      const result: SearxngResult = { title, url: raw.url, text };
      if (typeof raw.engine === "string" && raw.engine !== "")
        result.engine = sanitizeText(raw.engine, MAX_TITLE_CHARS);
      if (typeof raw.score === "number" && Number.isFinite(raw.score))
        result.score = raw.score;
      results.push(result);
      if (results.length >= maxResults) {
        dropped += payloadObject.results.length - index - 1;
        break;
      }
    }
    return { results, dropped };
  }
}
