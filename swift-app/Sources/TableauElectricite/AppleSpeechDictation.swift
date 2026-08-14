import AVFAudio
import CoreMedia
import Darwin.Mach
import Foundation
import Speech

struct AppleSpeechSegment: Encodable {
    let text: String
    let startMs: Int
    let durationMs: Int
}

struct AppleSpeechEvent: Encodable {
    let type: String
    var text: String? = nil
    var isFinal: Bool? = nil
    var model: String? = nil
    var firstTextMs: Int? = nil
    var transcriptionMs: Int? = nil
    var audioMs: Int? = nil
    var baselineMemoryBytes: UInt64? = nil
    var peakMemoryBytes: UInt64? = nil
    var contextualStrings: [String]? = nil
    var segments: [AppleSpeechSegment]? = nil
    var message: String? = nil
}

@MainActor
private protocol AppleSpeechSessionProtocol: AnyObject {
    func append(_ data: Data)
    func stop() async throws
    func cancel()
}

@MainActor
final class AppleSpeechController {
    typealias EventHandler = (AppleSpeechEvent) -> Void

    private let emit: EventHandler
    private var session: (any AppleSpeechSessionProtocol)?
    private var pendingAudio: [Data] = []
    private var pendingStop = false
    private var generation = 0

    init(emit: @escaping EventHandler) {
        self.emit = emit
    }

    func start(contextualStrings: [String]) {
        generation += 1
        let currentGeneration = generation
        session?.cancel()
        session = nil
        pendingAudio.removeAll(keepingCapacity: true)
        pendingStop = false

        guard #available(macOS 26.0, *) else {
            emit(.init(type: "error", message: "Apple Speech nécessite macOS 26 ou plus récent."))
            return
        }

        Task {
            do {
                let newSession = AppleSpeechSession(emit: emit)
                try await newSession.start(contextualStrings: contextualStrings)
                guard currentGeneration == generation else {
                    newSession.cancel()
                    return
                }
                session = newSession
                pendingAudio.forEach(newSession.append)
                pendingAudio.removeAll(keepingCapacity: true)
                if pendingStop {
                    pendingStop = false
                    try await newSession.stop()
                    session = nil
                }
            } catch {
                guard currentGeneration == generation else { return }
                pendingAudio.removeAll()
                emit(.init(type: "error", message: "Apple Speech : \(error.localizedDescription)"))
            }
        }
    }

    func append(_ data: Data) {
        if let session {
            session.append(data)
        } else if pendingAudio.reduce(0, { $0 + $1.count }) < 16000 * 2 * 90 {
            pendingAudio.append(data)
        }
    }

    func stop() {
        guard let session else {
            pendingStop = true
            return
        }
        Task {
            do {
                try await session.stop()
                self.session = nil
            } catch {
                self.session = nil
                emit(.init(type: "error", message: "Apple Speech : \(error.localizedDescription)"))
            }
        }
    }

    func cancel() {
        generation += 1
        pendingAudio.removeAll()
        pendingStop = false
        session?.cancel()
        session = nil
    }
}

@available(macOS 26.0, *)
@MainActor
private final class AppleSpeechSession: AppleSpeechSessionProtocol {
    private let emit: AppleSpeechController.EventHandler
    private var analyzer: SpeechAnalyzer?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var finalizedTranscript = ""
    private var volatileTranscript = ""
    private var finalizedSegments: [AppleSpeechSegment] = []
    private var startedNanoseconds: UInt64 = 0
    private var stoppedNanoseconds: UInt64?
    private var firstTextMs: Int?
    private var audioFrames = 0
    private var baselineMemoryBytes: UInt64 = 0
    private var peakMemoryBytes: UInt64 = 0
    private var contextualStrings: [String] = []
    private var analyzerFormat: AVAudioFormat?

    init(emit: @escaping AppleSpeechController.EventHandler) {
        self.emit = emit
    }

    func start(contextualStrings: [String]) async throws {
        let requestedLocale = Locale(identifier: "fr_FR")
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
            throw SpeechError.localeUnavailable
        }

        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: [.audioTimeRange]
        )
        try await installModelIfNeeded(for: transcriber)

        let context = AnalysisContext()
        self.contextualStrings = Array(contextualStrings.prefix(100))
        context.contextualStrings[.general] = self.contextualStrings

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        try await analyzer.setContext(context)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw SpeechError.audioFormatUnavailable
        }

        let (inputSequence, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream()
        self.analyzer = analyzer
        self.analyzerFormat = format
        self.inputBuilder = inputBuilder
        self.startedNanoseconds = DispatchTime.now().uptimeNanoseconds
        self.baselineMemoryBytes = residentMemoryBytes()
        self.peakMemoryBytes = baselineMemoryBytes

        resultsTask = Task { @MainActor [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self else { return }
                    self.receive(result)
                }
            } catch {
                guard !Task.isCancelled else { return }
                self?.emit(.init(type: "error", message: "Apple Speech : \(error.localizedDescription)"))
            }
        }

        try await analyzer.start(inputSequence: inputSequence)
    }

    func append(_ data: Data) {
        guard !data.isEmpty, let format = analyzerFormat else { return }
        let frameCount = data.count / MemoryLayout<Int16>.size
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)) else { return }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        let buffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        guard let destination = buffers.first?.mData else { return }
        data.copyBytes(to: destination.assumingMemoryBound(to: UInt8.self), count: data.count)
        buffers[0].mDataByteSize = UInt32(data.count)
        audioFrames += frameCount
        sampleMemory()
        inputBuilder?.yield(AnalyzerInput(buffer: buffer))
    }

    func stop() async throws {
        stoppedNanoseconds = DispatchTime.now().uptimeNanoseconds
        inputBuilder?.finish()
        inputBuilder = nil
        try await analyzer?.finalizeAndFinishThroughEndOfInput()
        await resultsTask?.value
        sampleMemory()

        let finalText = joined(finalizedTranscript, volatileTranscript).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !finalText.isEmpty else { throw SpeechError.noSpeech }
        let stopped = stoppedNanoseconds ?? DispatchTime.now().uptimeNanoseconds
        emit(.init(
            type: "transcript", text: finalText, isFinal: true,
            model: "SpeechAnalyzer/SpeechTranscriber fr-FR (on-device)",
            firstTextMs: firstTextMs,
            transcriptionMs: milliseconds(since: stopped),
            audioMs: Int((Double(audioFrames) / 16000.0) * 1000.0),
            baselineMemoryBytes: baselineMemoryBytes,
            peakMemoryBytes: peakMemoryBytes,
            contextualStrings: contextualStrings,
            segments: finalizedSegments
        ))
        analyzer = nil
        resultsTask = nil
    }

    func cancel() {
        inputBuilder?.finish()
        inputBuilder = nil
        resultsTask?.cancel()
        resultsTask = nil
        if let analyzer {
            Task { await analyzer.cancelAndFinishNow() }
        }
        analyzer = nil
    }

    private func receive(_ result: SpeechTranscriber.Result) {
        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if firstTextMs == nil { firstTextMs = milliseconds(since: startedNanoseconds) }
        sampleMemory()

        if result.isFinal {
            finalizedTranscript = joined(finalizedTranscript, text)
            volatileTranscript = ""
            finalizedSegments.append(.init(
                text: text,
                startMs: Int(CMTimeGetSeconds(result.range.start) * 1000.0),
                durationMs: Int(CMTimeGetSeconds(result.range.duration) * 1000.0)
            ))
        } else {
            volatileTranscript = text
        }

        emit(.init(
            type: "transcript",
            text: joined(finalizedTranscript, volatileTranscript),
            isFinal: false,
            model: "SpeechAnalyzer/SpeechTranscriber fr-FR (on-device)",
            firstTextMs: firstTextMs,
            audioMs: Int((Double(audioFrames) / 16000.0) * 1000.0),
            baselineMemoryBytes: baselineMemoryBytes,
            peakMemoryBytes: peakMemoryBytes,
            contextualStrings: contextualStrings,
            segments: finalizedSegments
        ))
    }

    private func installModelIfNeeded(for transcriber: SpeechTranscriber) async throws {
        let status = await AssetInventory.status(forModules: [transcriber])
        if status == .installed { return }
        guard status != .unsupported else { throw SpeechError.localeUnavailable }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    }

    private func sampleMemory() {
        peakMemoryBytes = max(peakMemoryBytes, residentMemoryBytes())
    }
}

private enum SpeechError: LocalizedError {
    case localeUnavailable
    case audioFormatUnavailable
    case noSpeech

    var errorDescription: String? {
        switch self {
        case .localeUnavailable: return "Le modèle français local n’est pas disponible."
        case .audioFormatUnavailable: return "Le format audio Apple Speech est indisponible."
        case .noSpeech: return "Aucune parole exploitable n’a été reconnue."
        }
    }
}

private func joined(_ prefix: String, _ suffix: String) -> String {
    if prefix.isEmpty { return suffix }
    if suffix.isEmpty { return prefix }
    return "\(prefix) \(suffix)"
}

private func milliseconds(since nanoseconds: UInt64) -> Int {
    Int((DispatchTime.now().uptimeNanoseconds - nanoseconds) / 1_000_000)
}

private func residentMemoryBytes() -> UInt64 {
    var info = mach_task_basic_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info_data_t>.size / MemoryLayout<natural_t>.size)
    let status = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
        }
    }
    return status == KERN_SUCCESS ? UInt64(info.resident_size) : 0
}
