import Foundation
import XCTest
@testable import LocalLabMlxMac

final class MLXMacRuntimeTests: XCTestCase {
    func testIntelAndUnsupportedArchitecturesAreGated() {
        XCTAssertEqual(MLXMacPlatform.capability(architecture: "x86_64").runtime, "no")
        #if !arch(arm64)
        XCTAssertEqual(MLXMacPlatform.capability(architecture: "arm64").runtime, "no")
        #endif
    }

    func testManifestHasStableMLXIdentity() throws {
        let manifest = MLXModelManifest(quantization: "4-bit", modelDirectory: "/models/test")
        let data = try JSONEncoder().encode(manifest)
        let decoded = try JSONDecoder().decode(MLXModelManifest.self, from: data)
        XCTAssertEqual(decoded.version, 1)
        XCTAssertEqual(decoded.backend, "mlx")
        XCTAssertEqual(decoded.format, "safetensors-folder")
    }

    func testMemoryFloorProducesActionableFailure() {
        XCTAssertThrowsError(try MLXMacRuntime.validateMemory(required: 1024, available: 512))
        XCTAssertNoThrow(try MLXMacRuntime.validateMemory(required: 512, available: 512))
        XCTAssertNoThrow(try MLXMacRuntime.validateMemory(required: nil, available: 0))
    }

    func testSamplingIsClampedAndFinite() {
        let sampling = MLXSampling(temperature: .infinity, topP: -1, maxTokens: 100_000)
        XCTAssertEqual(sampling.temperature, 0.7)
        XCTAssertEqual(sampling.topP, 0.01)
        XCTAssertEqual(sampling.maxTokens, 8192)
    }

    func testManifestRejectsInvalidFolder() {
        XCTAssertThrowsError(try MLXMacRuntime.validate(URL(fileURLWithPath: "/definitely/missing")))
    }
}
