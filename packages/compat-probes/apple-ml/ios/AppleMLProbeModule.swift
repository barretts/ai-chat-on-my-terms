import ExpoModulesCore
import Foundation

public final class AppleMLProbeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppleMLProbe")

    AsyncFunction("getDeviceFacts") { () -> [String: Any] in
      #if os(iOS) && arch(arm64)
      let platform = "ios"
      let architecture = "arm64"
      #else
      let platform = "other"
      let architecture = "other"
      #endif

      return [
        "platform": platform,
        "osMajor": ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
        "architecture": architecture,
        "hasNeuralEngine": NSNull(),
        "canLoadCoreML": NSNull(),
        "mlxMetalAvailable": NSNull(),
        "freeMemoryBytes": NSNull(),
      ]
    }

    AsyncFunction("runSmallMlxModel") { (_modelPath: String, _prompt: String) -> [String: Any] in
      Self.unsupported(engine: "MLX")
    }

    AsyncFunction("runCoreMLImageModel") { (_modelPath: String, _prompt: String, _seed: Int) -> [String: Any] in
      Self.unsupported(engine: "Core ML Stable Diffusion")
    }
  }

  private static func unsupported(engine: String) -> [String: Any] {
    [
      "ok": false,
      "error": [
        "code": "ENGINE_NOT_LINKED",
        "message": "The \(engine) inference adapter is not linked into this development build.",
        "recoverable": true,
      ],
    ]
  }
}
