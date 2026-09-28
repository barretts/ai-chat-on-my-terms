import Foundation
import LocalLabMlxMac

private struct Command: Decodable {
    let command: String
    let runId: String?
    let manifest: MLXModelManifest?
    let messages: [MLXChatMessage]?
    let sampling: MLXSampling?
}

private struct Event: Encodable {
    let type: String
    let runId: String?
    let sequence: Int
    let timestamp: String
    let text: String?
    let error: Failure?
    let capability: MLXMacCapability?
    let finishReason: String?
    let reason: String?
}

private struct Failure: Encodable {
    let code: String
    let message: String
    let recoverable: Bool
}

private final class EventWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let encoder = JSONEncoder()

    func emit(_ event: Event) {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? encoder.encode(event), let line = String(data: data, encoding: .utf8) else { return }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

@MainActor
private final class Worker {
    private let runtime = MLXMacRuntime()
    private let writer = EventWriter()
    private var generation: Task<Void, Never>?
    private var sequence = 0

    func run() async {
        event("WorkerReady", runId: nil, capability: MLXMacPlatform.capability())
        while let line = readLine() {
            guard let data = line.data(using: .utf8), let command = try? JSONDecoder().decode(Command.self, from: data) else {
                event("WorkerError", runId: nil, code: "invalid-request", message: "Command must be a JSON object.")
                continue
            }
            switch command.command {
            case "capabilities": event("Capabilities", runId: nil, capability: MLXMacPlatform.capability())
            case "load":
                guard let manifest = command.manifest else { event("WorkerError", runId: nil, code: "invalid-request", message: "Manifest is required."); continue }
                Task {
                    do { try await runtime.load(manifest: manifest); event("LoadCompleted", runId: nil) }
                catch {
                    event("WorkerError", runId: nil, code: failureCode(error),
                          message: error.localizedDescription, recoverable: failureRecoverable(error))
                }
                }
            case "unload":
                generation?.cancel()
                Task { await runtime.unload(); event("Unloaded", runId: nil) }
            case "generate": start(command)
            case "cancel":
                generation?.cancel()
            case "shutdown":
                generation?.cancel()
                Task { await runtime.unload() }
                return
            default: event("WorkerError", runId: command.runId, code: "invalid-request", message: "Unknown command.")
            }
        }
        generation?.cancel()
    }

    private func start(_ command: Command) {
        guard generation == nil else { event("WorkerError", runId: command.runId, code: "busy", message: "A generation is already active."); return }
        guard let runId = command.runId, !runId.isEmpty, let manifest = command.manifest,
              let messages = command.messages, let sampling = command.sampling else {
            event("WorkerError", runId: command.runId, code: "invalid-request", message: "runId, manifest, messages and sampling are required.")
            return
        }
        event("RunStarted", runId: runId)
        generation = Task {
            do {
                try await runtime.generate(manifest: manifest, messages: messages, sampling: sampling) { [weak self] text in
                    await self?.event("TextDelta", runId: runId, text: text)
                }
                if Task.isCancelled { event("RunCanceled", runId: runId, reason: "canceled") }
                else { event("RunCompleted", runId: runId, finishReason: "stop") }
            } catch is CancellationError { event("RunCanceled", runId: runId, reason: "canceled") }
            catch {
                event("RunFailed", runId: runId, code: failureCode(error),
                      message: error.localizedDescription, recoverable: failureRecoverable(error))
            }
            generation = nil
        }
    }

    private func event(_ type: String, runId: String?, text: String? = nil,
                       code: String? = nil, message: String? = nil, recoverable: Bool = true,
                       capability: MLXMacCapability? = nil, finishReason: String? = nil,
                       reason: String? = nil) {
        sequence += 1
        writer.emit(Event(type: type, runId: runId, sequence: sequence,
                          timestamp: ISO8601DateFormatter().string(from: Date()), text: text,
                          error: code.map { Failure(code: $0, message: message ?? "Request failed.", recoverable: recoverable) },
                          capability: capability, finishReason: finishReason, reason: reason))
    }

    private func failureCode(_ error: Error) -> String {
        guard let error = error as? MLXMacError else { return "inference-failed" }
        switch error {
        case .unsupported: return "unsupported"
        case .insufficientMemory: return "resource-exhausted"
        case .invalidModel: return "malformed"
        case .unloaded: return "missing-model"
        }
    }

    private func failureRecoverable(_ error: Error) -> Bool {
        guard let mlxError = error as? MLXMacError else { return true }
        if case .invalidModel(_) = mlxError { return false }
        return true
    }
}

let worker = await Worker()
await worker.run()
