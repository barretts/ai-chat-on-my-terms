import Foundation
import Darwin
import Dispatch
import MLXLMCommon
import MLXLLM

public struct MLXModelManifest: Codable, Sendable {
    public let version: Int
    public let backend: String
    public let format: String
    public let quantization: String
    public let modelDirectory: String
    public let minimumMemoryBytes: UInt64?

    public init(version: Int = 1, backend: String = "mlx", format: String = "safetensors-folder",
                quantization: String, modelDirectory: String, minimumMemoryBytes: UInt64? = nil) {
        self.version = version
        self.backend = backend
        self.format = format
        self.quantization = quantization
        self.modelDirectory = modelDirectory
        self.minimumMemoryBytes = minimumMemoryBytes
    }
}

public struct MLXMacCapability: Codable, Sendable {
    public let runtime: String
    public let architecture: String
    public let availableMemoryBytes: UInt64
    public let explanation: String?
}

public enum MLXMacError: Error, LocalizedError {
    case unsupported(String)
    case insufficientMemory(required: UInt64, available: UInt64)
    case invalidModel(String)
    case unloaded

    public var errorDescription: String? {
        switch self {
        case .unsupported(let reason): return reason
        case .insufficientMemory(let required, let available):
            return "Model needs at least \(required) bytes; only \(available) bytes are available."
        case .invalidModel(let reason): return reason
        case .unloaded: return "No MLX model is loaded."
        }
    }
}

public enum MLXMacPlatform {
    public static func capability(architecture: String = currentArchitecture,
                                  availableMemory: UInt64 = os_proc_available_memory()) -> MLXMacCapability {
        #if os(macOS) && arch(arm64)
        guard architecture == "arm64" else {
            return .init(runtime: "no", architecture: architecture, availableMemoryBytes: availableMemory,
                         explanation: "MLX local inference requires an Apple Silicon Mac. Intel Macs can use GGUF or a remote provider.")
        }
        return .init(runtime: "yes", architecture: architecture, availableMemoryBytes: availableMemory, explanation: nil)
        #elseif os(macOS)
        return .init(runtime: "no", architecture: architecture, availableMemoryBytes: availableMemory,
                     explanation: "MLX local inference requires an Apple Silicon Mac. Intel Macs can use GGUF or a remote provider.")
        #else
        return .init(runtime: "no", architecture: architecture, availableMemoryBytes: availableMemory,
                     explanation: "The MLX desktop worker is supported only on macOS Apple Silicon.")
        #endif
    }

    private static var currentArchitecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unsupported"
        #endif
    }
}

public struct MLXSampling: Codable, Sendable {
    public let temperature: Float
    public let topP: Float
    public let maxTokens: Int

    public init(temperature: Float, topP: Float, maxTokens: Int) {
        self.temperature = min(2, max(0, temperature.isFinite ? temperature : 0.7))
        self.topP = min(1, max(0.01, topP.isFinite ? topP : 0.95))
        self.maxTokens = min(8192, max(1, maxTokens))
    }
}

public struct MLXChatMessage: Codable, Sendable {
    public let role: String
    public let content: String
}

/// App-owned folder loader. It never installs tools or fetches a model itself.
public actor MLXMacRuntime {
    private var container: ModelContainer?
    private var modelPath: URL?
    private var pressureSource: DispatchSourceMemoryPressure?

    public init() {
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            Task { await self?.unload() }
        }
        source.resume()
        pressureSource = source
    }

    public func load(manifest: MLXModelManifest) async throws {
        let capability = MLXMacPlatform.capability()
        guard capability.runtime == "yes" else { throw MLXMacError.unsupported(capability.explanation ?? "MLX is unavailable") }
        guard manifest.version == 1, manifest.backend == "mlx", manifest.format == "safetensors-folder" else {
            throw MLXMacError.invalidModel("Unsupported MLX model manifest.")
        }
        let folder = URL(fileURLWithPath: manifest.modelDirectory, isDirectory: true).standardizedFileURL
        try Self.validate(folder)
        let available = os_proc_available_memory()
        try Self.validateMemory(required: manifest.minimumMemoryBytes, available: available)
        if modelPath == folder, container != nil { return }
        container = try await LLMModelFactory.shared.loadContainer(configuration: .init(directory: folder))
        modelPath = folder
    }

    public func generate(manifest: MLXModelManifest, messages: [MLXChatMessage], sampling: MLXSampling,
                         yield: @escaping @Sendable (String) async -> Void) async throws {
        try await load(manifest: manifest)
        guard let container else { throw MLXMacError.unloaded }
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
        for await item in stream {
            try Task.checkCancellation()
            if case .chunk(let text) = item, !text.isEmpty { await yield(text) }
        }
    }

    public func unload() {
        container = nil
        modelPath = nil
    }

    public static func validateMemory(required: UInt64?, available: UInt64) throws {
        if let required, available < required {
            throw MLXMacError.insufficientMemory(required: required, available: available)
        }
    }

    public static func validate(_ folder: URL) throws {
        guard folder.isFileURL else { throw MLXMacError.invalidModel("MLX model must be an app-managed local folder.") }
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &directory), directory.boolValue else {
            throw MLXMacError.invalidModel("Managed MLX model folder was not found.")
        }
        guard FileManager.default.fileExists(atPath: folder.appendingPathComponent("config.json").path) else {
            throw MLXMacError.invalidModel("MLX folder is missing config.json.")
        }
        let walker = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        var foundWeights = false
        while let file = walker?.nextObject() as? URL {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw MLXMacError.invalidModel("MLX folder contains a symbolic link.") }
            if values.isRegularFile == true && file.pathExtension.lowercased() == "safetensors" { foundWeights = true }
        }
        guard foundWeights else { throw MLXMacError.invalidModel("MLX folder needs at least one safetensors file.") }
    }
}
