import Foundation

public enum NativeCapability: String, Codable, Sendable {
    case yes
    case no
    case unknown
}

public struct AppleDeviceFacts: Codable, Sendable {
    public let platform: String
    public let osMajor: Int
    public let architecture: String
    public let hasNeuralEngine: NativeCapability
    public let canLoadCoreML: NativeCapability
    public let mlxMetalAvailable: NativeCapability
    public let freeMemoryBytes: UInt64?

    public init(
        platform: String,
        osMajor: Int,
        architecture: String,
        hasNeuralEngine: NativeCapability = .unknown,
        canLoadCoreML: NativeCapability = .unknown,
        mlxMetalAvailable: NativeCapability = .unknown,
        freeMemoryBytes: UInt64? = nil
    ) {
        self.platform = platform
        self.osMajor = osMajor
        self.architecture = architecture
        self.hasNeuralEngine = hasNeuralEngine
        self.canLoadCoreML = canLoadCoreML
        self.mlxMetalAvailable = mlxMetalAvailable
        self.freeMemoryBytes = freeMemoryBytes
    }
}

public enum AppleMLProbeErrorCode: String, Codable, Sendable {
    case nativeBuildRequired = "NATIVE_BUILD_REQUIRED"
    case unsupportedHardware = "UNSUPPORTED_HARDWARE"
    case engineNotLinked = "ENGINE_NOT_LINKED"
    case modelNotFound = "MODEL_NOT_FOUND"
    case inferenceFailed = "INFERENCE_FAILED"
}

public struct AppleMLProbeFailure: Codable, Sendable {
    public let code: AppleMLProbeErrorCode
    public let message: String
    public let recoverable: Bool

    public init(code: AppleMLProbeErrorCode, message: String, recoverable: Bool = true) {
        self.code = code
        self.message = message
        self.recoverable = recoverable
    }
}

public enum AppleMLProbeResult<Value: Codable & Sendable>: Codable, Sendable {
    case success(Value)
    case failure(AppleMLProbeFailure)

    private enum CodingKeys: String, CodingKey { case ok, value, error }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .success(let value):
            try container.encode(true, forKey: .ok)
            try container.encode(value, forKey: .value)
        case .failure(let error):
            try container.encode(false, forKey: .ok)
            try container.encode(error, forKey: .error)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if try container.decode(Bool.self, forKey: .ok) {
            self = .success(try container.decode(Value.self, forKey: .value))
        } else {
            self = .failure(try container.decode(AppleMLProbeFailure.self, forKey: .error))
        }
    }
}

public enum AppleMLProbeCore {
    public static func engineNotLinked(_ engine: String) -> AppleMLProbeResult<ProbeReceipt> {
        .failure(.init(
            code: .engineNotLinked,
            message: "The \(engine) inference adapter is not linked into this development build. Use its configured fallback.",
            recoverable: true
        ))
    }
}

public struct ProbeReceipt: Codable, Sendable {
    public let engine: String
    public let deviceModel: String
    public let osVersion: String
    public let appBuildHash: String
    public let modelHash: String
    public let outputHash: String
    public let elapsedMs: Double
}
