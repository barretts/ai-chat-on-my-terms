import Foundation
import MLXLMCommon
import MLXLLM

public enum MLXCapability: String, Sendable {
    case yes, no, unknown
}

public struct MLXDeviceCapability: Sendable {
    public let runtime: MLXCapability
    public let explanation: String?

    public init(runtime: MLXCapability, explanation: String? = nil) {
        self.runtime = runtime
        self.explanation = explanation
    }
}

public struct MLXSampling: Sendable {
    public let temperature: Float
    public let topP: Float
    public let maxTokens: Int

    public init(temperature: Float, topP: Float, maxTokens: Int) {
        self.temperature = min(2, max(0, temperature.isFinite ? temperature : 0.7))
        self.topP = min(1, max(0.01, topP.isFinite ? topP : 0.95))
        self.maxTokens = min(8192, max(1, maxTokens))
    }
}

public struct MLXChatMessage: Sendable {
    public let role: String
    public let content: String

    public init(role: String, content: String) {
        self.role = role
        self.content = content
    }
}

public enum MLXInferenceEvent: Sendable {
    case text(String)
    case failed(code: String, message: String, recoverable: Bool)
}

/// Loads only an app-managed, validated model directory. GGUF uses a separate backend.
public actor MLXInferenceAdapter {
    private let capability: @Sendable () async -> MLXDeviceCapability
    private var container: ModelContainer?
    private var loadedDirectory: URL?

    public init(capability: @escaping @Sendable () async -> MLXDeviceCapability) {
        self.capability = capability
    }

    public func load(folder: URL) async throws {
        let decision = await capability()
        guard decision.runtime == .yes else {
            throw MLXAdapterError.unsupported(
                decision.explanation ?? "MLX support is unavailable or unverified on this device; use a GGUF or remote provider."
            )
        }
        try Self.validateModelFolder(folder)
        if loadedDirectory == folder, container != nil { return }
        container = try await LLMModelFactory.shared.loadContainer(
            configuration: .init(directory: folder)
        )
        loadedDirectory = folder
    }

    public func generate(
        folder: URL,
        messages: [MLXChatMessage],
        sampling: MLXSampling
    ) async -> AsyncThrowingStream<MLXInferenceEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await self.load(folder: folder)
                    guard let container = await self.container else {
                        throw MLXAdapterError.modelUnavailable
                    }
                    var parameters = GenerateParameters(maxTokens: sampling.maxTokens)
                    parameters.temperature = sampling.temperature
                    parameters.topP = sampling.topP
                    let chat = messages.map { message -> Chat.Message in
                        switch message.role {
                        case "system": return .system(message.content)
                        case "assistant": return .assistant(message.content)
                        case "tool": return .tool(message.content)
                        default: return .user(message.content)
                        }
                    }
                    let input = try await container.prepare(input: UserInput(chat: chat))
                    let stream = try await container.generate(input: input, parameters: parameters)
                    for await generation in stream {
                        try Task.checkCancellation()
                        if case .chunk(let text) = generation, !text.isEmpty {
                            continuation.yield(.text(text))
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: CancellationError())
                } catch let error as MLXAdapterError {
                    continuation.yield(.failed(code: error.code, message: error.localizedDescription, recoverable: error.recoverable))
                    continuation.finish()
                } catch {
                    continuation.yield(.failed(code: "inference-failed", message: error.localizedDescription, recoverable: true))
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func unload() {
        container = nil
        loadedDirectory = nil
    }

    public static func validateModelFolder(_ folder: URL) throws {
        guard folder.isFileURL else { throw MLXAdapterError.invalidFolder("Model folder must be a local managed directory") }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw MLXAdapterError.invalidFolder("Managed MLX model folder was not found")
        }
        let config = folder.appendingPathComponent("config.json")
        guard FileManager.default.fileExists(atPath: config.path) else {
            throw MLXAdapterError.invalidFolder("MLX model folder is missing config.json")
        }
        let enumerator = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        var hasWeights = false
        while let item = enumerator?.nextObject() as? URL {
            let values = try item.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw MLXAdapterError.invalidFolder("MLX folder contains a symbolic link") }
            if values.isRegularFile == true, item.pathExtension.lowercased() == "safetensors" { hasWeights = true }
        }
        guard hasWeights else { throw MLXAdapterError.invalidFolder("MLX folder needs at least one safetensors weight file") }
    }
}

public enum MLXAdapterError: LocalizedError {
    case unsupported(String)
    case invalidFolder(String)
    case modelUnavailable

    public var code: String {
        switch self {
        case .unsupported: return "unsupported-hardware"
        case .invalidFolder: return "malformed"
        case .modelUnavailable: return "missing-model"
        }
    }
    public var recoverable: Bool { if case .invalidFolder = self { return false }; return true }
    public var errorDescription: String? {
        switch self {
        case .unsupported(let message), .invalidFolder(let message): return message
        case .modelUnavailable: return "MLX model failed to load"
        }
    }
}
