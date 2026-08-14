import Foundation
import AVFAudio
import Speech
import CoreMedia

@available(macOS 26.0, *)
@main
struct AppleSpeechCli {
    static func main() async {
        do {
            try await run()
            exit(0)
        } catch {
            let message = ["error": String(describing: error)]
            if let data = try? JSONSerialization.data(withJSONObject: message, options: []) {
                FileHandle.standardError.write(data)
                FileHandle.standardError.write("\n".data(using: .utf8)!)
            } else {
                FileHandle.standardError.write(("{\"error\":\"" + String(describing: error) + "\"}\n").data(using: .utf8)!)
            }
            exit(1)
        }
    }

    static func run() async throws {
        let args = CommandLine.arguments
        guard args.count >= 2 else { throw NSError(domain: "AppleSpeechCli", code: 1, userInfo: [NSLocalizedDescriptionKey: "Usage: AppleSpeechCli <wav-file>"]) }
        let wav = URL(fileURLWithPath: args[1])
        let requestedLocale = Locale(identifier: "fr_FR")
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
            throw NSError(domain: "AppleSpeechCli", code: 2, userInfo: [NSLocalizedDescriptionKey: "SpeechTranscriber fr_FR unavailable"]) }

        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: [.audioTimeRange]
        )

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let context = AnalysisContext()
        try await analyzer.setContext(context)
        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(domain: "AppleSpeechCli", code: 3, userInfo: [NSLocalizedDescriptionKey: "Analyzer audio format unavailable"]) }

        let (stream, builder) = AsyncStream<AnalyzerInput>.makeStream()
        var finalizedTranscript = ""
        var volatileTranscript = ""
        var finalizedSegments: [[String: Any]] = []
        var firstTextMs: Int? = nil
        var audioFrames = 0
        var baselineMemory: UInt64 = residentMemoryBytes()
        var peakMemory: UInt64 = baselineMemory
        let started = DispatchTime.now().uptimeNanoseconds

        let resultsTask = Task { @MainActor in
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { continue }
                    if firstTextMs == nil { firstTextMs = Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000) }
                    peakMemory = max(peakMemory, residentMemoryBytes())
                    if result.isFinal {
                        finalizedTranscript = (finalizedTranscript.isEmpty ? "" : finalizedTranscript + " ") + text
                        volatileTranscript = ""
                        let seg: [String: Any] = [
                            "text": text,
                            "startMs": Int(CMTimeGetSeconds(result.range.start) * 1000.0),
                            "durationMs": Int(CMTimeGetSeconds(result.range.duration) * 1000.0)
                        ]
                        finalizedSegments.append(seg)
                    } else {
                        volatileTranscript = text
                    }
                }
            } catch {
                // ignore
            }
        }

        try await analyzer.start(inputSequence: stream)

        // Read source WAV file bytes and extract PCM chunk manually. AVAudioFile can fail in some contexts;
        // parsing the WAV header and using raw PCM is more robust for CLI testing.
        let wavData = try Data(contentsOf: wav)
        func readUInt32LE(_ data: Data, _ offset: Int) -> UInt32 {
            guard offset + 4 <= data.count else { return 0 }
            return data.withUnsafeBytes { ptr -> UInt32 in
                let base = ptr.bindMemory(to: UInt8.self)
                let p = base.baseAddress!.advanced(by: offset)
                return UInt32(p[0]) | (UInt32(p[1]) << 8) | (UInt32(p[2]) << 16) | (UInt32(p[3]) << 24)
            }
        }
        func readUInt16LE(_ data: Data, _ offset: Int) -> UInt16 {
            guard offset + 2 <= data.count else { return 0 }
            return data.withUnsafeBytes { ptr -> UInt16 in
                let base = ptr.bindMemory(to: UInt8.self)
                let p = base.baseAddress!.advanced(by: offset)
                return UInt16(p[0]) | (UInt16(p[1]) << 8)
            }
        }

        var fmtSampleRate: Double = 16000.0
        var fmtChannels: AVAudioChannelCount = 1
        var fmtBitsPerSample: UInt16 = 16
        var pcmChunk: Data? = nil

        // Minimal RIFF/WAVE parser
        if wavData.count >= 44, String(data: wavData.subdata(in: 0..<4), encoding: .ascii) == "RIFF" {
            var offset = 12
            while offset + 8 <= wavData.count {
                let idData = wavData.subdata(in: offset..<(offset+4))
                guard let id = String(data: idData, encoding: .ascii) else { break }
                let size = Int(readUInt32LE(wavData, offset + 4))
                let chunkStart = offset + 8
                if chunkStart + size > wavData.count { break }
                if id == "fmt " {
                    let audioFormat = readUInt16LE(wavData, chunkStart + 0)
                    let channels = readUInt16LE(wavData, chunkStart + 2)
                    let sampleRate = readUInt32LE(wavData, chunkStart + 4)
                    let bitsPerSample = readUInt16LE(wavData, chunkStart + 14)
                    fmtSampleRate = Double(sampleRate)
                    fmtChannels = AVAudioChannelCount(channels)
                    fmtBitsPerSample = bitsPerSample
                    // audioFormat 1 = PCM
                } else if id == "data" {
                    pcmChunk = wavData.subdata(in: chunkStart..<(chunkStart + size))
                    break
                }
                offset = chunkStart + size + (size % 2)
            }
        }

        guard let pcm = pcmChunk, pcm.count > 0 else {
            throw NSError(domain: "AppleSpeechCli", code: 5, userInfo: [NSLocalizedDescriptionKey: "WAV PCM chunk not found or empty"])
        }

        // Build a source AVAudioFormat matching the PCM
        let sourceCommon: AVAudioCommonFormat = (fmtBitsPerSample == 16) ? .pcmFormatInt16 : .pcmFormatFloat32
        guard let sourceFormat = AVAudioFormat(commonFormat: sourceCommon, sampleRate: fmtSampleRate, channels: fmtChannels, interleaved: true) else {
            throw NSError(domain: "AppleSpeechCli", code: 6, userInfo: [NSLocalizedDescriptionKey: "Unable to create source AVAudioFormat"]) }

        // Create a single large buffer and feed it in chunks
        let bytesPerSample = Int(fmtBitsPerSample) / 8
        let bytesPerFrame = bytesPerSample * Int(fmtChannels)
        let totalFrames = pcm.count / bytesPerFrame
        let frameCapacity: AVAudioFrameCount = 1024 * 8
        var byteOffset = 0
        while byteOffset < pcm.count {
            let maxChunk = Int(frameCapacity) * bytesPerFrame
            let chunkBytes = min(maxChunk, pcm.count - byteOffset)
            let frames = chunkBytes / bytesPerFrame
            guard let sourceBuffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(frames)) else { break }
            sourceBuffer.frameLength = AVAudioFrameCount(frames)
            let dst = UnsafeMutableAudioBufferListPointer(sourceBuffer.mutableAudioBufferList)
            if let ptr = dst.first?.mData {
                pcm.copyBytes(to: ptr.assumingMemoryBound(to: UInt8.self), from: byteOffset..<(byteOffset+chunkBytes))
                dst[0].mDataByteSize = UInt32(chunkBytes)
            }
            byteOffset += chunkBytes
            audioFrames += frames
            peakMemory = max(peakMemory, residentMemoryBytes())

            // If analyzer accepts same format, yield directly
            if sourceFormat.isEqual(analyzerFormat) || (sourceFormat.sampleRate == analyzerFormat.sampleRate && sourceFormat.channelCount == analyzerFormat.channelCount && sourceFormat.commonFormat == analyzerFormat.commonFormat) {
                builder.yield(AnalyzerInput(buffer: sourceBuffer))
                continue
            }

            // Convert chunk to analyzer format
            if let converter = AVAudioConverter(from: sourceFormat, to: analyzerFormat) {
                let ratio = analyzerFormat.sampleRate / sourceFormat.sampleRate
                let destCapacity = AVAudioFrameCount(Double(frames) * max(1.0, ratio) + 1.0)
                if let dest = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: destCapacity) {
                    var inputConsumed = false
                    let inputBlock: AVAudioConverterInputBlock = { inNumPackets, outStatus in
                        if inputConsumed { outStatus.pointee = .noDataNow; return nil }
                        inputConsumed = true
                        outStatus.pointee = .haveData
                        return sourceBuffer
                    }
                    var err: NSError?
                    let status = converter.convert(to: dest, error: &err, withInputFrom: inputBlock)
                    if err != nil || status == .error {
                        builder.yield(AnalyzerInput(buffer: dest))
                    } else {
                        if dest.frameLength == 0 { dest.frameLength = dest.frameCapacity }
                        builder.yield(AnalyzerInput(buffer: dest))
                    }
                }
            } else {
                builder.yield(AnalyzerInput(buffer: sourceBuffer))
            }
        }


        builder.finish()
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        await resultsTask.value

        let finalText = (finalizedTranscript + (volatileTranscript.isEmpty ? "" : " " + volatileTranscript)).trimmingCharacters(in: .whitespacesAndNewlines)
        let stopped = DispatchTime.now().uptimeNanoseconds
        if finalText.isEmpty { throw NSError(domain: "AppleSpeechCli", code: 4, userInfo: [NSLocalizedDescriptionKey: "No speech recognized"]) }

        let output: [String: Any] = [
            "text": finalText,
            "segments": finalizedSegments,
            "firstTextMs": firstTextMs as Any,
            "transcriptionMs": Int((stopped - started) / 1_000_000),
            "audioMs": Int((Double(audioFrames) / 16000.0) * 1000.0),
            "baselineMemoryBytes": baselineMemory,
            "peakMemoryBytes": peakMemory
        ]

        let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted])
        if let s = String(data: data, encoding: .utf8) {
            print(s)
        }

        try await analyzer.cancelAndFinishNow()
    }

    static func residentMemoryBytes() -> UInt64 {
        var info = mach_task_basic_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info_data_t>.size / MemoryLayout<natural_t>.size)
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return status == KERN_SUCCESS ? UInt64(info.resident_size) : 0
    }
}
