// Minimal type surface for the vendored `ws` 7.5.13 server (no @types/ws is
// pinned in this repository). Only the members the relay sources use are
// declared; this file exists so this project's typecheck can compile
// `@locallab/relay` (imported by the gate smoke tests). It mirrors
// services/relay/src/ws.d.ts.
declare module "ws" {
  import type { IncomingMessage, Server as HttpServer } from "node:http";
  import type { Socket } from "node:net";

  export interface WebSocket {
    readonly readyState: number;
    readonly bufferedAmount: number;
    /** Private in ws 7.x (promoted to public in 8.x); used for byte-level flow control. */
    readonly _socket: Socket;
    send(data: string | Uint8Array): void;
    ping(): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: "message", listener: (data: { toString(encoding?: string): string }, isBinary: boolean) => void): void;
    on(event: "close", listener: (code: number, reason: { toString(): string }) => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "pong", listener: () => void): void;
    on(event: "open", listener: () => void): void;
  }

  export class Server {
    constructor(options: { server: HttpServer; maxPayload?: number });
    on(
      event: "connection",
      listener: (socket: WebSocket, request: IncomingMessage) => void,
    ): void;
    clients: Set<WebSocket>;
    close(callback?: () => void): void;
  }

  const wsModule: (new (address: string) => WebSocket) & { Server: typeof Server };
  export default wsModule;
}
