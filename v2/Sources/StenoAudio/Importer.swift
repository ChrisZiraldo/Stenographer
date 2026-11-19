@preconcurrency import AVFoundation
import Foundation
import StenoModel

public enum Importer {
    /// Decodes any AVFoundation-readable file into `raw/import-001.wav` and writes a captured manifest.
    @discardableResult
    public static func importAudio(from src: URL, into dir: URL, id: UUID, createdAt: Date = Date()) throws -> SessionManifest {
        let file = try AVAudioFile(forReading: src)
        let inFormat = file.processingFormat
        let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
        guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
            throw CaptureError.unsupportedStreamFormat("cannot convert \(inFormat)")
        }
        converter.downmix = true

        let relative = "raw/import-001.wav"
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("raw"), withIntermediateDirectories: true)
        let out = try WAVWriter(url: dir.appendingPathComponent(relative))
        let inBuffer = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: 65_536)!
        let outCapacity = AVAudioFrameCount(Double(65_536) * 16_000 / inFormat.sampleRate) + 4096
        let outBuffer = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: outCapacity)!

        final class Feed: @unchecked Sendable {
            var readError: Error?
            var finished = false
        }
        let feed = Feed()
        let block: AVAudioConverterInputBlock = { _, status in
            if feed.finished || file.framePosition >= file.length {
                feed.finished = true
                status.pointee = .endOfStream
                return nil
            }
            do {
                try file.read(into: inBuffer)
            } catch {
                feed.readError = error
                feed.finished = true
                status.pointee = .endOfStream
                return nil
            }
            if inBuffer.frameLength == 0 {
                feed.finished = true
                status.pointee = .endOfStream
                return nil
            }
            status.pointee = .haveData
            return inBuffer
        }

        while true {
            outBuffer.frameLength = 0
            var error: NSError?
            let status = converter.convert(to: outBuffer, error: &error, withInputFrom: block)
            if let error { throw error }
            if let readError = feed.readError { throw readError }
            if outBuffer.frameLength > 0 {
                try out.append(UnsafeBufferPointer(start: outBuffer.floatChannelData![0], count: Int(outBuffer.frameLength)))
            }
            if status == .endOfStream || status == .error { break }
        }
        try out.close()

        let timebase = HostTime.timebase
        let manifest = SessionManifest(
            id: id, createdAt: createdAt, mode: .imported, t0HostTime: 0, timebaseNumer: timebase.numer,
            timebaseDenom: timebase.denom, state: .captured, endedAt: createdAt.addingTimeInterval(Double(out.sampleCount) / 16_000),
            parts: [
                CapturePart(
                    index: 1, kind: .imported, file: relative, firstHostTime: 0, offsetSamples: 0,
                    sampleCount: out.sampleCount, deviceUID: nil, deviceName: src.lastPathComponent,
                    nativeSampleRate: inFormat.sampleRate, endReason: .stopped)
            ])
        try ManifestIO.write(manifest, to: ManifestIO.url(in: dir))
        return manifest
    }
}
