import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type StreamFormat = "text/event-stream" | "application/x-ndjson";

export interface FragmentedServerOptions {
  readonly contentType: StreamFormat;
  readonly fragments: readonly Uint8Array[];
  readonly delayMs?: number;
}

export interface FragmentedServer {
  readonly url: string;
  readonly disconnected: Promise<void>;
  close(): Promise<void>;
}

/** Starts a loopback-only HTTP stream fixture that preserves the supplied byte boundaries. */
export async function startFragmentedServer(
  options: FragmentedServerOptions,
): Promise<FragmentedServer> {
  const delayMs = options.delayMs ?? 0;
  let resolveDisconnected!: () => void;
  let disconnectedResolved = false;
  const disconnected = new Promise<void>((resolve) => {
    resolveDisconnected = resolve;
  });
  const markDisconnected = (): void => {
    if (disconnectedResolved) return;
    disconnectedResolved = true;
    resolveDisconnected();
  };

  const server: Server = createServer((request, response) => {
    if (request.url !== "/stream") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, {
      "content-type": `${options.contentType}; charset=utf-8`,
      "cache-control": "no-store",
      connection: "close",
    });
    let endedNormally = false;
    response.once("close", () => {
      if (!endedNormally) markDisconnected();
    });

    void (async () => {
      for (const fragment of options.fragments) {
        if (response.destroyed) return;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (response.destroyed) return;
        response.write(Buffer.from(fragment));
      }
      endedNormally = true;
      response.end();
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/stream`,
    disconnected,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Splits encoded text at byte offsets, including offsets inside multibyte UTF-8 characters. */
export function splitUtf8(text: string, offsets: readonly number[]): Buffer[] {
  const bytes = Buffer.from(text, "utf8");
  const cuts = [...new Set(offsets)]
    .filter(
      (offset) =>
        Number.isInteger(offset) && offset > 0 && offset < bytes.length,
    )
    .sort((left, right) => left - right);
  const result: Buffer[] = [];
  let start = 0;
  for (const end of [...cuts, bytes.length]) {
    result.push(bytes.subarray(start, end));
    start = end;
  }
  return result;
}

/** Decodes arbitrary network byte fragments without corrupting split UTF-8 sequences. */
export function decodeUtf8Fragments(fragments: readonly Uint8Array[]): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  for (const fragment of fragments) {
    text += decoder.decode(fragment, { stream: true });
  }
  return text + decoder.decode();
}

export function parseSseData<T>(text: string): T[] {
  const values: T[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length > 0) values.push(JSON.parse(data.join("\n")) as T);
  }
  return values;
}

export function parseNdjson<T>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
