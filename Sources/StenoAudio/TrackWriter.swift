@preconcurrency import AVFoundation
import Foundation
import StenoModel

/// Drains one ring into one WAV part at 16 kHz. Used only from the writer thread, so `@unchecked Sendable`:
/// the converter's input block captures `self`, and the SDK on newer toolchains requires that block to be `@Sendable`.
final class TrackWriter: @unchecked Sendable {
    static let chunkFrames = 8192

    let kind: TrackKind
    let ring: SPSCRingBuffer
    let wav: WAVWriter
    private(set) var part: CapturePart

    private let converter: AVAudioConverter
    private let input: AVAudioPCMBuffer
    private let output: AVAudioPCMBuffer
    private var inputPending = false
    private var endOfStream = false
    private lazy var inputBlock: AVAudioConverterInputBlock = { [unowned self] _, status in
        if self.inputPending {
            self.inputPending = false
            status.pointee = .haveData
            return self.input
        }
        status.pointee = self.endOfStream ? .endOfStream : .noDataNow
        return nil
    }

    /// Called with each converted 16 kHz block and its absolute start on the session timeline.
    var onConverted: ((UnsafeBufferPointer<Float>, Int64) -> Void)?

    init(kind: TrackKind, ring: SPSCRingBuffer, part: CapturePart, sessionDirectory: URL) throws {
        self.kind = kind
        self.ring = ring
        self.part = part
        let inFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: part.nativeSampleRate, channels: 1, interleaved: false)!
        let outFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: Double(WAVWriter.sampleRate), channels: 1, interleaved: false)!
        guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
            throw CaptureError.unsupportedStreamFormat("no converter from \(part.nativeSampleRate) Hz")
        }
        self.converter = converter
        input = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(Self.chunkFrames))!
        let outCapacity = Int((Double(Self.chunkFrames) * 16_000 / part.nativeSampleRate).rounded(.up)) + 1024
        output = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(outCapacity))!
        wav = try WAVWriter(url: sessionDirectory.appendingPathComponent(part.file))
    }

    /// Moves everything currently in the ring (plus silence for dropped frames) into the WAV.
    /// Returns the number of native frames dropped since the last call.
    @discardableResult
    func drain() throws -> Int64 {
        let dropped = ring.dropped.exchange(0, ordering: .relaxed)
        var silence = dropped
        while silence > 0 {
            let n = Int(min(silence, Int64(Self.chunkFrames)))
            input.floatChannelData![0].update(repeating: 0, count: n)
            try convert(frames: n)
            silence -= Int64(n)
        }
        while true {
            let n = ring.read(into: input.floatChannelData![0], max: Self.chunkFrames)
            if n == 0 { break }
            try convert(frames: n)
        }
        return dropped
    }

    /// Drains, flushes the converter and closes the WAV. Returns the finished part.
    func finish(reason: PartEndReason) throws -> CapturePart {
        try drain()
        endOfStream = true
        while true {
            output.frameLength = 0
            var error: NSError?
            let status = converter.convert(to: output, error: &error, withInputFrom: inputBlock)
            if let error { throw error }
            try emit()
            if status == .endOfStream || status == .error || output.frameLength == 0 { break }
        }
        try wav.close()
        part.sampleCount = wav.sampleCount
        part.endReason = reason
        return part
    }

    private func convert(frames: Int) throws {
        input.frameLength = AVAudioFrameCount(frames)
        inputPending = true
        while inputPending {
            output.frameLength = 0
            var error: NSError?
            _ = converter.convert(to: output, error: &error, withInputFrom: inputBlock)
            if let error { throw error }
            try emit()
        }
    }

    private func emit() throws {
        let n = Int(output.frameLength)
        guard n > 0 else { return }
        let samples = UnsafeBufferPointer(start: output.floatChannelData![0], count: n)
        let start = part.offsetSamples + wav.sampleCount
        try wav.append(samples)
        onConverted?(samples, start)
    }
}
