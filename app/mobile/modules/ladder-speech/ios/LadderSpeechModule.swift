// On-device dictation with SpeechAnalyzer + SpeechTranscriber (iOS 26). Everything stays on the device: the language model is downloaded
// from Apple with AssetInventory (once, on first use) and recognition runs on the phone. No audio goes to a server.
import AVFoundation
import ExpoModulesCore
import Foundation
import Speech

public class LadderSpeechModule: Module {
  // The engine lives while listening (iOS 26+); held as Any so the class isn't tied to #available.
  private var engineBox: Any?

  public func definition() -> ModuleDefinition {
    Name("LadderSpeech")
    Events("result", "level", "progress", "end", "error")

    Function("isAvailable") { () -> Bool in
      if #available(iOS 26, *) { return SpeechTranscriber.isAvailable }
      return false
    }

    AsyncFunction("assetStatus") { (locale: String) async throws -> [String: Any?] in
      guard #available(iOS 26, *) else { return ["status": "unsupported", "bytes": nil] }
      return try await LadderSpeechEngine.assetStatus(locale)
    }

    AsyncFunction("install") { [weak self] (locale: String) async throws in
      guard #available(iOS 26, *) else { throw LadderSpeechFailure.unavailable }
      try await LadderSpeechEngine.install(locale) { fraction in
        self?.sendEvent("progress", ["fraction": fraction])
      }
    }

    AsyncFunction("micPermission") { () -> String in
      guard #available(iOS 17, *) else { return "denied" }
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return "granted"
      case .denied: return "denied"
      default: return "undetermined"
      }
    }

    AsyncFunction("requestMic") { () async -> Bool in
      guard #available(iOS 17, *) else { return false }
      return await AVAudioApplication.requestRecordPermission()
    }

    AsyncFunction("start") { [weak self] (locale: String, contextual: [String]) async throws in
      guard #available(iOS 26, *) else { throw LadderSpeechFailure.unavailable }
      guard let self else { return }
      // The previous listening closes silently: its `end` must not reach the new attempt's JS.
      if let old = self.engineBox as? LadderSpeechEngine { await old.abort(silent: true) }
      let engine = LadderSpeechEngine(
        onResult: { text, final in self.sendEvent("result", ["text": text, "isFinal": final]) },
        onLevel: { level in self.sendEvent("level", ["level": level]) },
        onEnd: { self.sendEvent("end") },
        onError: { message in self.sendEvent("error", ["message": message]) })
      self.engineBox = engine
      try await engine.start(locale: locale, contextual: contextual)
    }

    AsyncFunction("stop") { [weak self] () async in
      guard #available(iOS 26, *) else { return }
      await (self?.engineBox as? LadderSpeechEngine)?.stop()
    }

    Function("abort") { [weak self] () in
      guard #available(iOS 26, *) else { return }
      let engine = self?.engineBox as? LadderSpeechEngine
      Task { await engine?.abort(silent: false) }
    }
  }
}

enum LadderSpeechFailure: LocalizedError {
  case unavailable
  case unsupportedLocale(String)
  case noFormat

  var errorDescription: String? {
    switch self {
    case .unavailable: return "On-device dictation is not available on this device."
    case .unsupportedLocale(let l): return "Dictation does not support \(l)."
    case .noFormat: return "No audio format is available for dictation."
    }
  }
}

@available(iOS 26, *)
actor LadderSpeechEngine {
  private let onResult: (String, Bool) -> Void
  private let onLevel: (Double) -> Void
  private let onEnd: () -> Void
  private let onError: (String) -> Void

  private var analyzer: SpeechAnalyzer?
  private var transcriber: SpeechTranscriber?
  private var audio: AVAudioEngine?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var collector: Task<Void, Never>?
  private var finished = false
  // Cancelled (stop or abort) while startup is still in progress, or replaced by a new listening: no more events for JS.
  private var cancelled = false
  private var muted = false
  private let gate = SpeechGate()

  init(onResult: @escaping (String, Bool) -> Void, onLevel: @escaping (Double) -> Void, onEnd: @escaping () -> Void, onError: @escaping (String) -> Void) {
    self.onResult = onResult
    self.onLevel = onLevel
    self.onEnd = onEnd
    self.onError = onError
  }

  private func emitEnd() { if !muted { onEnd() } }
  private func emitError(_ message: String) { if !muted { onError(message) } }
  private func ensureLive() throws { if cancelled { throw CancellationError() } }

  // MARK: language model

  private static func transcriber(for locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
  }

  private static func resolve(_ identifier: String) async throws -> Locale {
    guard SpeechTranscriber.isAvailable else { throw LadderSpeechFailure.unavailable }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) else {
      throw LadderSpeechFailure.unsupportedLocale(identifier)
    }
    return locale
  }

  static func assetStatus(_ identifier: String) async throws -> [String: Any?] {
    guard SpeechTranscriber.isAvailable else { return ["status": "unsupported", "bytes": nil] }
    guard let locale = try? await resolve(identifier) else { return ["status": "unsupported", "bytes": nil] }
    let module = transcriber(for: locale)
    switch await AssetInventory.status(forModules: [module]) {
    case .installed:
      return ["status": "installed", "bytes": nil]
    case .downloading:
      return ["status": "downloading", "bytes": nil]
    case .supported:
      // The system may say how large the download is: show it only if it really does.
      var bytes: Double? = nil
      if let request = try? await AssetInventory.assetInstallationRequest(supporting: [module]) {
        let total = request.progress.totalUnitCount
        if total > 1_000_000 { bytes = Double(total) }
      }
      return ["status": "supported", "bytes": bytes]
    case .unsupported:
      return ["status": "unsupported", "bytes": nil]
    @unknown default:
      return ["status": "unsupported", "bytes": nil]
    }
  }

  static func install(_ identifier: String, progress: @escaping (Double) -> Void) async throws {
    let locale = try await resolve(identifier)
    let module = transcriber(for: locale)
    switch await AssetInventory.status(forModules: [module]) {
    case .installed:
      break
    case .unsupported:
      throw LadderSpeechFailure.unsupportedLocale(identifier)
    default:
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
        let p = request.progress
        let poll = Task {
          while !Task.isCancelled {
            progress(min(1, max(0, p.fractionCompleted)))
            try? await Task.sleep(nanoseconds: 250_000_000)
          }
        }
        defer { poll.cancel() }
        try await request.downloadAndInstall()
        progress(1)
      }
    }
    try? await AssetInventory.reserve(locale: locale)
  }

  // MARK: listening

  func start(locale identifier: String, contextual: [String]) async throws {
    do {
      try await startSession(locale: identifier, contextual: contextual)
    } catch is CancellationError {
      // stop or abort during startup: everything off, no error for JS.
      await teardown()
      didFinish(error: nil)
    } catch {
      // A failed startup leaves neither the microphone on nor the transcriber half-started.
      await teardown()
      throw error
    }
  }

  private func startSession(locale identifier: String, contextual: [String]) async throws {
    let locale = try await Self.resolve(identifier)
    try ensureLive()
    let module = Self.transcriber(for: locale)
    guard await AssetInventory.status(forModules: [module]) == .installed else {
      throw LadderSpeechFailure.unsupportedLocale(identifier)
    }
    try ensureLive()
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
      throw LadderSpeechFailure.noFormat
    }
    try ensureLive()
    let analyzer = SpeechAnalyzer(modules: [module])
    if !contextual.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings[.general] = contextual
      try? await analyzer.setContext(context)
      try ensureLive()
    }
    self.transcriber = module
    self.analyzer = analyzer

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    self.input = continuation

    // Transcriptions arrive from the transcriber while audio comes in.
    let gate = self.gate
    collector = Task { [onResult, weak self] in
      do {
        for try await result in module.results {
          if gate.open { onResult(String(result.text.characters), result.isFinal) }
        }
        await self?.didFinish(error: nil)
      } catch {
        await self?.didFinish(error: error)
      }
    }

    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement, options: [])
    try session.setActive(true, options: [])

    let engine = AVAudioEngine()
    let inputFormat = engine.inputNode.outputFormat(forBus: 0)
    guard let converter = AVAudioConverter(from: inputFormat, to: format) else { throw LadderSpeechFailure.noFormat }
    let level = onLevel
    engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
      if gate.open { level(Self.level(of: buffer)) }
      let ratio = format.sampleRate / inputFormat.sampleRate
      let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
      guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
      var supplied = false
      var error: NSError?
      converter.convert(to: out, error: &error) { _, status in
        if supplied {
          status.pointee = .noDataNow
          return nil
        }
        supplied = true
        status.pointee = .haveData
        return buffer
      }
      if error == nil, out.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: out)) }
    }
    self.audio = engine
    engine.prepare()
    try engine.start()
    try ensureLive()

    try await analyzer.start(inputSequence: stream)
    try ensureLive()
  }

  /// Buffer volume (RMS) mapped to 0..1.
  private static func level(of buffer: AVAudioPCMBuffer) -> Double {
    guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
    let rms = sqrt(sum / Float(buffer.frameLength))
    let db = 20 * log10(max(rms, 0.000_01))
    return Double(max(0, min(1, (db + 60) / 50)))
  }

  private func stopAudio() {
    audio?.inputNode.removeTap(onBus: 0)
    audio?.stop()
    audio = nil
    input?.finish()
    input = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// Turns off microphone, collector and analyzer (used by a failed or cancelled startup, and by abort).
  private func teardown() async {
    stopAudio()
    collector?.cancel()
    collector = nil
    await analyzer?.cancelAndFinishNow()
    analyzer = nil
    transcriber = nil
  }

  /// Closes listening and gives the transcriber time to finish the sentence. If startup hasn't finished, cancels it.
  func stop() async {
    cancelled = true
    guard let analyzer else { return }
    stopAudio()
    do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch { await analyzer.cancelAndFinishNow() }
  }

  /// `silent`: listening is replaced by another, its `end` must not reach JS.
  func abort(silent: Bool) async {
    cancelled = true
    if silent {
      muted = true
      gate.open = false
    }
    await teardown()
    if !finished {
      finished = true
      emitEnd()
    }
  }

  private func didFinish(error: Error?) {
    guard !finished else { return }
    finished = true
    stopAudio()
    analyzer = nil
    transcriber = nil
    if let error, !(error is CancellationError) { emitError(error.localizedDescription) }
    emitEnd()
  }
}

/// Switch read by the audio thread and the collector: off, listening sends nothing more to JS.
final class SpeechGate: @unchecked Sendable {
  private let lock = NSLock()
  private var value = true
  var open: Bool {
    get { lock.lock(); defer { lock.unlock() }; return value }
    set { lock.lock(); value = newValue; lock.unlock() }
  }
}
