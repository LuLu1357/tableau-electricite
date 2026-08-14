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
    // peak - baseline is often the most useful number to display
    var memoryDeltaBytes: UInt64? = nil
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

    // Native audio capture
    private var audioEngine: AVAudioEngine?
    private var tapInstalled = false
    private var audioConverter: AVAudioConverter?

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

        // Start native audio capture and feed AnalyzerInput from the input node.
        if let format = analyzerFormat {
            try setupAudioEngine(captureFormat: format)
        }
    }

    private func setupAudioEngine(captureFormat: AVAudioFormat) throws {
        // Avoid double installs
        if tapInstalled { return }

        let engine = AVAudioEngine()
        self.audioEngine = engine
        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)

        if !inputFormat.isEqual(captureFormat) {
            audioConverter = AVAudioConverter(from: inputFormat, to: captureFormat)
        } else {
            audioConverter = nil
        }

        // Install tap on input node
        let frameSize: AVAudioFrameCount = 1024
        input.installTap(onBus: 0, bufferSize: frameSize, format: inputFormat) { [weak self] buffer, _ in
            guard let self = self else { return }
            // Copy/convert buffer to analyzerFormat and yield
            guard let analyzerFormat = self.analyzerFormat else { return }

            if let converter = self.audioConverter {
                // Estimate required capacity
                let ratio = analyzerFormat.sampleRate / inputFormat.sampleRate
                let outCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
                guard let outBuffer = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: outCapacity) else { return }
                var error: NSError? = nil
                let status = converter.convert(to: outBuffer, error: &error) { _, outStatus in
                    outStatus.pointee = .haveData
                    return buffer
                }
                if status == .haveData {
                    outBuffer.frameLength = outBuffer.frameLength > 0 ? outBuffer.frameLength : AVAudioFrameCount(Double(buffer.frameLength) * ratio)
                    self.audioFrames += Int(outBuffer.frameLength)
                    self.sampleMemory()
                    self.inputBuilder?.yield(AnalyzerInput(buffer: outBuffer))
                }
            } else {
                // Same format: copy buffer content to a new buffer to be safe
                guard let copy = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: buffer.frameLength) else { return }
                copy.frameLength = buffer.frameLength
                let srcList = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
                let dstList = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
                for i in 0..<min(srcList.count, dstList.count) {
                    let src = srcList[i]
                    var dst = dstList[i]
                    memcpy(dst.mData, src.mData, Int(src.mDataByteSize))
                    dst.mDataByteSize = src.mDataByteSize
                }
                self.audioFrames += Int(copy.frameLength)
                self.sampleMemory()
                self.inputBuilder?.yield(AnalyzerInput(buffer: copy))
            }
        }

        try engine.start()
        tapInstalled = true
    }
    func append(_ data: Data) {
        // Incoming audio is expected to be PCM Int16 mono 16kHz from the browser.
        // The analyzerFormat may differ — never blindly copy raw bytes into a buffer
        // that expects floats, different sample rate, or interleaving. Use an
        // AVAudioConverter when necessary.
        guard !data.isEmpty, let analyzerFormat = analyzerFormat else { return }

        // Source format: PCM Int16, 16 kHz, mono, interleaved — matches browser output
        guard let sourceFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000.0, channels: 1, interleaved: true) else { return }

        let sourceFrameCount = data.count / MemoryLayout<Int16>.size
        guard sourceFrameCount > 0 else { return }

        // Create a source buffer and copy the raw PCM into it
        guard let sourceBuffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(sourceFrameCount)) else { return }
        sourceBuffer.frameLength = AVAudioFrameCount(sourceFrameCount)
        let srcBuffers = UnsafeMutableAudioBufferListPointer(sourceBuffer.mutableAudioBufferList)
        if let srcDest = srcBuffers.first?.mData {
            data.copyBytes(to: srcDest.assumingMemoryBound(to: UInt8.self), count: data.count)
            srcBuffers[0].mDataByteSize = UInt32(data.count)
        }


        // If analyzer accepts the same format, submit directly (avoid conversion)
        if analyzerFormat.isEqual(sourceFormat) || (analyzerFormat.sampleRate == sourceFormat.sampleRate && analyzerFormat.channelCount == sourceFormat.channelCount && analyzerFormat.commonFormat == sourceFormat.commonFormat) {
            // Need to create a buffer with analyzerFormat if formats are equal but object differs
            if analyzerFormat == sourceFormat {
                // Direct submit — count frames at analyzer rate (same as source)
                self.audioFrames += Int(sourceBuffer.frameLength)
                self.sampleMemory()
                inputBuilder?.yield(AnalyzerInput(buffer: sourceBuffer))
                return
            }
        }

        // Otherwise, convert to analyzerFormat using AVAudioConverter
        guard let converter = AVAudioConverter(from: sourceFormat, to: analyzerFormat) else {
            // Fallback: attempt to coerce by creating a buffer in analyzerFormat and copying bytes conservatively
            if let fallback = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: AVAudioFrameCount(sourceFrameCount)) {
                fallback.frameLength = AVAudioFrameCount(sourceFrameCount)
                let dst = UnsafeMutableAudioBufferListPointer(fallback.mutableAudioBufferList)
                if let dstPtr = dst.first?.mData {
                    data.copyBytes(to: dstPtr.assumingMemoryBound(to: UInt8.self), count: min(data.count, Int(dst.first!.mDataByteSize)))
                    dst[0].mDataByteSize = UInt32(min(data.count, Int(dst.first!.mDataByteSize)))
                }
                inputBuilder?.yield(AnalyzerInput(buffer: fallback))
                self.audioFrames += Int(fallback.frameLength)
                self.sampleMemory()
            }
            return
        }

        // Create destination buffer sized to hold the converted frames.
        // Estimate capacity by scaling with sample rates
        let ratio = analyzerFormat.sampleRate / sourceFormat.sampleRate
        let destCapacity = AVAudioFrameCount(Double(sourceFrameCount) * max(1.0, ratio) + 1.0)
        guard let destBuffer = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: destCapacity) else { return }

        var error: NSError? = nil
        // Provide the source buffer exactly once to the converter, then indicate endOfStream.
        var provided = false
        let inputBlock: AVAudioConverterInputBlock = { inNumPackets, outStatus in
            if provided {
                outStatus.pointee = .endOfStream
                return nil
            }
            provided = true
            outStatus.pointee = .haveData
            return sourceBuffer
        }

        let status = converter.convert(to: destBuffer, error: &error, withInputFrom: inputBlock)
        if status == .error || error != nil {
            // conversion failed — emit best-effort raw source in analyzer format buffer
            if let fallback = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: AVAudioFrameCount(sourceFrameCount)) {
                fallback.frameLength = AVAudioFrameCount(sourceFrameCount)
                let dst = UnsafeMutableAudioBufferListPointer(fallback.mutableAudioBufferList)
                if let dstPtr = dst.first?.mData {
                    data.copyBytes(to: dstPtr.assumingMemoryBound(to: UInt8.self), count: min(data.count, Int(dst.first!.mDataByteSize)))
                    dst[0].mDataByteSize = UInt32(min(data.count, Int(dst.first!.mDataByteSize)))
                }
                inputBuilder?.yield(AnalyzerInput(buffer: fallback))
                // Count frames submitted to analyzer (best-effort)
                self.audioFrames += Int(fallback.frameLength)
            }
            return
        }

        // Ensure frameLength is correct
        if destBuffer.frameLength == 0 {
            destBuffer.frameLength = destBuffer.frameCapacity
        }

        // Count the frames actually provided to analyzer (after conversion)
        self.audioFrames += Int(destBuffer.frameLength)
        self.sampleMemory()
        inputBuilder?.yield(AnalyzerInput(buffer: destBuffer))
    }

    func stop() async throws {
        stoppedNanoseconds = DispatchTime.now().uptimeNanoseconds

        // Stop native capture first to avoid feeding more audio after stop
        if tapInstalled, let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            audioEngine = nil
            tapInstalled = false
            audioConverter = nil
        }

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
            memoryDeltaBytes: peakMemoryBytes >= baselineMemoryBytes ? (peakMemoryBytes - baselineMemoryBytes) : 0,
            contextualStrings: contextualStrings,
            segments: finalizedSegments
        ))
        analyzer = nil
        resultsTask = nil
    }

    func cancel() {
        // Ensure capture stopped and taps removed
        if tapInstalled, let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            audioEngine = nil
            tapInstalled = false
            audioConverter = nil
        }

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
            memoryDeltaBytes: peakMemoryBytes >= baselineMemoryBytes ? (peakMemoryBytes - baselineMemoryBytes) : 0,
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
