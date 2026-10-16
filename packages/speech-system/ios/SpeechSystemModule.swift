import AVFoundation
import ExpoModulesCore
import Speech

public final class SpeechSystemModule: Module {
  private final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    weak var owner: SpeechSystemModule?

    init(owner: SpeechSystemModule) {
      self.owner = owner
      super.init()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
      DispatchQueue.main.async { [weak self] in
        guard let owner = self?.owner, let promise = owner.speakPromise else { return }
        owner.speakPromise = nil
        promise.resolve(["ok": true, "value": NSNull()])
      }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
      DispatchQueue.main.async { [weak self] in
        guard let owner = self?.owner, let promise = owner.speakPromise else { return }
        owner.speakPromise = nil
        promise.resolve(SpeechSystemModule.failure("CANCELED", "System playback was interrupted."))
      }
    }
  }

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
  private lazy var speechDelegate = SpeechDelegate(owner: self)
  private lazy var synthesizer: AVSpeechSynthesizer = {
    let synth = AVSpeechSynthesizer()
    synth.delegate = speechDelegate
    return synth
  }()
  private var speakPromise: Promise?
  private var captureEngine: AVAudioEngine?
  private var captureBuffer: [Float] = []
  private var captureRate: Double = 16000

  private final class StartOptions: Record {
    @Field var requestId: String = ""
    @Field var locale: String? = nil
    @Field var onDeviceOnly: Bool = false
  }

  private final class RequestOptions: Record {
    @Field var requestId: String = ""
  }

  private final class SpeakOptions: Record {
    @Field var text: String = ""
    @Field var language: String? = nil
    @Field var voiceIdentifier: String? = nil
    @Field var rate: Double = 1.0
    @Field var pitch: Double = 1.0
  }

  private final class CaptureOptions: Record {
    @Field var sampleRate: Double = 16000
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

    // MARK: - System text-to-speech (T072 system output half)

    Function("isSpeaking") { () -> Bool in
      self.synthesizer.isSpeaking
    }

    AsyncFunction("getSpeakAvailability") { () -> [String: Any] in
      ["ok": true, "value": ["availability": "ready"]]
    }

    AsyncFunction("getSpeechVoices") { () -> [String: Any] in
      let voices = AVSpeechSynthesisVoice.speechVoices().map { voice in
        [
          "identifier": voice.identifier,
          "language": voice.language,
          "name": voice.name,
        ]
      }
      return ["ok": true, "value": voices]
    }

    AsyncFunction("speak") { (options: SpeakOptions, promise: Promise) in
      guard !options.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        promise.resolve(["ok": true, "value": NSNull()])
        return
      }
      guard self.speakPromise == nil, !self.synthesizer.isSpeaking else {
        promise.resolve(Self.failure("BUSY", "The system voice is already speaking."))
        return
      }
      let utterance = AVSpeechUtterance(string: options.text)
      let rate = max(0.5, min(2.0, options.rate))
      let pitch = max(0.5, min(2.0, options.pitch))
      utterance.rate = AVSpeechUtteranceDefaultSpeechRate * Float(rate)
      utterance.pitchMultiplier = Float(pitch)
      if let identifier = options.voiceIdentifier,
         let voice = AVSpeechSynthesisVoice(identifier: identifier) {
        utterance.voice = voice
      } else if let language = options.language {
        utterance.voice = AVSpeechSynthesisVoice(language: language)
      }
      self.speakPromise = promise
      self.synthesizer.speak(utterance)
    }

    AsyncFunction("stopSpeaking") { () -> [String: Any] in
      self.stopSpeak(["ok": true, "value": NSNull()])
      return ["ok": true, "value": NSNull()]
    }

    // MARK: - Raw PCM capture for local Whisper (T077)

    AsyncFunction("requestCapturePermission") { (promise: Promise) in
      if AVAudioApplication.shared.recordPermission == .granted {
        promise.resolve(["ok": true, "value": ["granted": true]])
        return
      }
      AVAudioApplication.requestRecordPermission { granted in
        DispatchQueue.main.async {
          promise.resolve(["ok": true, "value": ["granted": granted]])
        }
      }
    }

    AsyncFunction("startCapture") { (options: CaptureOptions, promise: Promise) in
      guard self.captureEngine == nil else {
        promise.resolve(Self.failure("BUSY", "Audio capture is already running."))
        return
      }
      guard self.active.isEmpty else {
        promise.resolve(Self.failure("BUSY", "Dictation is using the microphone."))
        return
      }
      do {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        let rate = options.sampleRate > 0 ? options.sampleRate : 16000
        guard let target = AVAudioFormat(
          commonFormat: .pcmFormatFloat32,
          sampleRate: rate,
          channels: 1,
          interleaved: false
        ), let converter = AVAudioConverter(from: inputFormat, to: target) else {
          throw NSError(
            domain: "SpeechSystem",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Could not configure the audio converter."]
          )
        }
        self.captureBuffer.removeAll()
        self.captureRate = rate
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
          guard let self else { return }
          let ratio = target.sampleRate / inputFormat.sampleRate
          let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
          guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            return
          }
          var fed = false
          var conversionError: NSError?
          converter.convert(to: out, error: &conversionError) { status, outCondition in
            if fed {
              outCondition.pointee = .noDataNow
              return nil
            }
            fed = true
            outCondition.pointee = .haveData
            return buffer
          }
          guard conversionError == nil, out.frameLength > 0,
                let channel = out.floatChannelData?[0] else { return }
          self.captureBuffer.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
        }
        engine.prepare()
        try engine.start()
        self.captureEngine = engine
        promise.resolve(["ok": true, "value": NSNull()])
      } catch {
        self.teardownCapture()
        promise.resolve(
          Self.failure("FAILED", "Could not start audio capture: \(error.localizedDescription)")
        )
      }
    }

    AsyncFunction("stopCapture") { () -> [String: Any] in
      self.teardownCapture()
      return [
        "ok": true,
        "value": [
          "sampleRate": self.captureRate,
          "samples": self.captureBuffer
        ]
      ]
    }

    AsyncFunction("cancelCapture") { () -> [String: Any] in
      self.teardownCapture()
      self.captureBuffer.removeAll()
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

  /// Settles the pending `speak` promise once, before any delegate callback
  /// for the same utterance can touch it again.
  private func stopSpeak(_ result: [String: Any]) {
    guard let promise = speakPromise else {
      return
    }
    speakPromise = nil
    if synthesizer.isSpeaking || synthesizer.isPaused {
      synthesizer.stopSpeaking(at: .immediate)
    }
    DispatchQueue.main.async {
      promise.resolve(result)
    }
  }
  private func teardownCapture() {
    if let engine = captureEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    captureEngine = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
  private static func failure(_ code: String, _ message: String) -> [String: Any] {
    ["ok": false, "error": ["code": code, "message": message]]
  }
}
