import type { RunEvent, RunRequest } from "./run-events";
import type { TypedErrorCodeSchema } from "./entities";
import type { z } from "zod";

export type TypedErrorCode = z.infer<typeof TypedErrorCodeSchema>;
export type Capability = "yes" | "no" | "unknown";
export type CapabilityMap = Readonly<Record<string, Capability>>;
export type PortResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: TypedErrorCode;
        message: string;
        recoverable: boolean;
        backend?: string;
      };
    };

export interface ProviderPort<Connection = unknown> {
  listModels(
    connection: Connection,
    signal?: AbortSignal,
  ): Promise<PortResult<readonly string[]>>;
  getCapabilities(
    connection: Connection,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<PortResult<CapabilityMap>>;
  startRun(request: RunRequest, signal: AbortSignal): AsyncIterable<RunEvent>;
  dispose?(): Promise<void> | void;
}

export interface ModelManagerPort<Model = unknown, Progress = unknown> {
  list(signal?: AbortSignal): Promise<PortResult<readonly Model[]>>;
  download(
    modelId: string,
    signal: AbortSignal,
    onProgress?: (progress: Progress) => void,
  ): Promise<PortResult<void>>;
  cancel(jobId: string): Promise<PortResult<void>>;
  load(modelId: string, signal?: AbortSignal): Promise<PortResult<void>>;
  unload(modelId: string): Promise<PortResult<void>>;
  status(
    modelId: string,
  ): Promise<
    PortResult<"missing" | "downloading" | "ready" | "loaded" | "error">
  >;
  dispose(): Promise<void> | void;
}
