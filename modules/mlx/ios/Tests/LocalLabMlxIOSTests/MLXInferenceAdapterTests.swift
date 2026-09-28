import Foundation
import XCTest
@testable import LocalLabMlxIOS

final class MLXInferenceAdapterTests: XCTestCase {
    func testSamplingValuesAreBounded() {
        let sampling = MLXSampling(temperature: 9, topP: -1, maxTokens: 100_000)
        XCTAssertEqual(sampling.temperature, 2)
        XCTAssertEqual(sampling.topP, 0.01)
        XCTAssertEqual(sampling.maxTokens, 8192)
    }

    func testManagedFolderNeedsConfigAndSafeTensorWeights() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("{}".utf8).write(to: root.appendingPathComponent("config.json"))
        try Data([0]).write(to: root.appendingPathComponent("model.safetensors"))
        XCTAssertNoThrow(try MLXInferenceAdapter.validateModelFolder(root))
    }

    func testRejectsMissingWeightsAndNonLocalURLs() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("{}".utf8).write(to: root.appendingPathComponent("config.json"))
        XCTAssertThrowsError(try MLXInferenceAdapter.validateModelFolder(root))
        XCTAssertThrowsError(try MLXInferenceAdapter.validateModelFolder(URL(string: "https://example.invalid/model")!))
    }
}
