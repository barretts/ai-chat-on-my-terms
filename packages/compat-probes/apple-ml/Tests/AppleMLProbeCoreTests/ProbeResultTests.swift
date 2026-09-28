import XCTest
@testable import AppleMLProbeCore

final class ProbeResultTests: XCTestCase {
    func testEngineNotLinkedIsMachineReadableAndRecoverable() throws {
        let result = AppleMLProbeCore.engineNotLinked("MLX")
        let data = try JSONEncoder().encode(result)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["ok"] as? Bool, false)
        let error = try XCTUnwrap(object["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "ENGINE_NOT_LINKED")
        XCTAssertEqual(error["recoverable"] as? Bool, true)
    }
}
