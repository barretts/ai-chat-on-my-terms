import XCTest

// Host commands drive the real app through XCTest; this code never ships in the app.
final class CaptureUITests: XCTestCase {
    func testCaptureSession() throws {
        continueAfterFailure = false
        executionTimeAllowance = 3600
        let app = XCUIApplication(bundleIdentifier: "app.locallab.mobile")
        app.launch()
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let commandURL = documents.appendingPathComponent("command.json")
        let responseURL = documents.appendingPathComponent("response.json")
        print("CAPTURE_DOCUMENTS=\(documents.path)")
        let existing = (try? Data(contentsOf: commandURL))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
        var previous = existing?["id"] ?? ""
        let deadline = Date().addingTimeInterval(3600)
        while Date() < deadline {
            guard let data = try? Data(contentsOf: commandURL),
                  let command = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                  let id = command["id"], id != previous else {
                Thread.sleep(forTimeInterval: 0.25)
                continue
            }
            previous = id
            var result = "ok"
            let action = command["action"] ?? "tree"
            let label = command["label"] ?? ""
            switch action {
            case "tap":
                let element = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ OR label == %@", label, label)).firstMatch
                if element.waitForExistence(timeout: 5) && element.isHittable {
                    element.tap()
                } else { result = "Element unavailable or not hittable: \(label)" }
            case "type": app.typeText(command["text"] ?? "")
            case "home": XCUIDevice.shared.press(.home)
            case "tapPoint":
                let x = Double(command["x"] ?? "0") ?? 0
                let y = Double(command["y"] ?? "0") ?? 0
                app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
            case "drag":
                let from = app.coordinate(withNormalizedOffset: CGVector(
                    dx: Double(command["fromX"] ?? "0.5") ?? 0.5,
                    dy: Double(command["fromY"] ?? "0.5") ?? 0.5))
                let to = app.coordinate(withNormalizedOffset: CGVector(
                    dx: Double(command["toX"] ?? "0.5") ?? 0.5,
                    dy: Double(command["toY"] ?? "0.6") ?? 0.6))
                from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.3)
            case "swipeUp": app.swipeUp()
            case "swipeDown": app.swipeDown()
            case "rotate":
                switch command["orientation"] {
                case "landscapeLeft": XCUIDevice.shared.orientation = .landscapeLeft
                case "landscapeRight": XCUIDevice.shared.orientation = .landscapeRight
                default: XCUIDevice.shared.orientation = .portrait
                }
            case "activate": app.activate()
            case "tree": break
            case "stop": break
            default: result = "Unknown command: \(action)"
            }
            Thread.sleep(forTimeInterval: 1)
            let response: [String: String] = ["id": id, "result": result, "tree": app.debugDescription]
            try JSONSerialization.data(withJSONObject: response, options: .prettyPrinted).write(to: responseURL, options: .atomic)
            if action == "stop" { return }
        }
    }
}
