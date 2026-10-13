import AVFoundation
import ExpoModulesCore
import Speech

public final class SpeechSystemModule: Module {
  private final class ActiveRequest {
    let requestId: String
    let recognizer: SFSpeechRecognizer
    var task: SFSpeechRecognitionTask?
    var tapInstalled = false
    var finalText: String?
    var failure: String?
    var stopPromise: Promise?
    init(requestId: String, recognizer: SFSpeechRecognizer) {
      self.requestId = requestId
      self.recognizer = recognizer
    }
  }

  private var engine: AVAudioEngine?
  private var active: [String: ActiveRequest] = [:]

  private final class StartOptions: Record {
    @Field var requestId: String = ""
    @Field var locale: String? = nil
    @Field var onDeviceOnly: Bool = false
  }

  private final class RequestOptions: Record {
    @Field var requestId: String = ""
  }

  public func definition() -> ModuleDefinition {
    Name("SpeechSystem")

    Events(["partial"])

    AsyncFunction("getAvailability") { () -> [String: Any] in
      let speechStatus = SFSpeechRecognizer.authorizationStatus()
      let micGranted = AVAudioApplication.shared.recordPermission == .granted
      let permission: String
      switch speechStatus {
      case .notDetermined: permission = "notDetermined"
      case .denied: permission = "denied"
      case .restricted: permission = "restricted"
      default: permission = micGranted ? "granted" : "denied"
      }
      let defaultRecognizer = SFSpeechRecognizer()
      let availability: String
      if permission == "granted" && defaultRecognizer != nil {
        availability = "ready"
      } else if permission == "notDetermined" {
        availability = "ready"
      } else if permission == "restricted" || defaultRecognizer == nil {
        availability = "unavailable"
      } else {
        availability = "permission"
      }
      let locales = SFSpeechRecognizer.supportedLocales()
        .map { $0.identifier(.bcp47) }
        .sorted()
      return [
        "ok": true,
        "value": [
          "availability": availability,
          "permission": permission,
          "onDeviceSupported": defaultRecognizer?.supportsOnDeviceRecognition ?? false,
          "locales": locales,
        ],
      ]
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
        SFSpeechRecognizer.requestAuthorization { speechStatus in
          DispatchQueue.main.async {
            AVAudioApplication.requestRecordPermission { micGranted in
              let granted =
                speechStatus == .authorized && micGranted
              let status: String
              if granted {
                status = "granted"
              } else if speechStatus == .denied || !micGranted {
                status = "denied"
              } else {
                status = "restricted"
              }
              promise.resolve(["ok": true, "value": ["permission": status]])
            }
          }
        }
      }

    AsyncFunction("startListening") { (options: StartOptions, promise: Promise) in
      guard !options.requestId.isEmpty else {
        promise.resolve(Self.failure("MALFORMED", "requestId is required."))
        return
      }
      let locale = options.locale.map { Locale(identifier: $0) }
        ?? Locale.current
      guard let recognizer = SFSpeechRecognizer(locale: locale) else {
        promise.resolve(
          Self.failure("UNSUPPORTED_LOCALE", "This language is not supported for recognition on this device."))
        return
      }
      if options.onDeviceOnly && !recognizer.supportsOnDeviceRecognition {
        promise.resolve(
          Self.failure("ON_DEVICE_UNAVAILABLE", "Offline-only recognition is not available for this language."))
        return
      }
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.shouldReportPartialResults = true
      request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
      let sessionError = self.configureAudioSession()
      if let sessionError {
        promise.resolve(Self.failure("AUDIO_SESSION_FAILED", sessionError))
        return
      }
      let entry = ActiveRequest(requestId: options.requestId, recognizer: recognizer)
      let inputNode = self.engine!.inputNode
      let format = inputNode.outputFormat(forBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
      }
      entry.tapInstalled = true
      self.engine!.prepare()
      do {
        try self.engine!.start()
      } catch {
        inputNode.removeTap(onBus: 0)
        entry.tapInstalled = false
        self.stopEngine()
        promise.resolve(
          Self.failure("CAPTURE_FAILED", "The microphone could not be started: \(error.localizedDescription)"))
        return
      }
      entry.task = recognizer.recognitionTask(with: request) { result, error in
        DispatchQueue.main.async {
          guard let current = self.active[options.requestId] else { return }
          if let result {
            let text = result.bestTranscription.formattedString
            current.finalText = text
            self.sendEvent("partial", [
              "requestId": options.requestId,
              "text": text,
              "isFinal": result.isFinal,
            ])
            if let stopPromise = current.stopPromise {
              current.stopPromise = nil
              self.teardown(current)
              stopPromise.resolve(["ok": true, "value": ["text": text]])
            }
          }
          if let error {
            current.failure = error.localizedDescription
            if let stopPromise = current.stopPromise {
              current.stopPromise = nil
              self.teardown(current)
              if current.finalText != nil {
                stopPromise.resolve(["ok": true, "value": ["text": current.finalText!]])
              } else {
                stopPromise.resolve(
                  Self.failure("RECOGNITION_FAILED", error.localizedDescription))
              }
            }
          }
        }
      }
      self.active[options.requestId] = entry
      promise.resolve([
        "ok": true,
        "value": [
          "locale": recognizer.locale.identifier(.bcp47),
          "onDevice": request.requiresOnDeviceRecognition,
        ],
      ])
    }

    AsyncFunction("stopListening") { (options: RequestOptions, promise: Promise) in
      guard let entry = self.active[options.requestId] else {
        promise.resolve(Self.failure("STALE_REQUEST", "This recognition request is no longer active."))
        return
      }
      entry.task?.finish()
      if let text = entry.finalText {
        self.teardown(entry)
        promise.resolve(["ok": true, "value": ["text": text]])
      } else if entry.failure != nil {
        let message = entry.failure!
        self.teardown(entry)
        promise.resolve(Self.failure("RECOGNITION_FAILED", message))
      } else {
        entry.stopPromise = promise
      }
    }

    AsyncFunction("cancelListening") { (options: RequestOptions) -> [String: Any] in
      if let entry = self.active[options.requestId] {
        entry.task?.cancel()
        self.teardown(entry)
      }
      return ["ok": true, "value": NSNull()]
    }
  }

  private func configureAudioSession() -> String? {
    engine = AVAudioEngine()
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      return nil
    } catch {
      engine = nil
      return error.localizedDescription
    }
  }

  private func teardown(_ entry: ActiveRequest) {
    active.removeValue(forKey: entry.requestId)
    if let engine {
      if entry.tapInstalled {
        engine.inputNode.removeTap(onBus: 0)
      }
      engine.stop()
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func stopEngine() {
    engine?.stop()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    engine = nil
  }

  private static func failure(_ code: String, _ message: String) -> [String: Any] {
    ["ok": false, "error": ["code": code, "message": message]]
  }
}
