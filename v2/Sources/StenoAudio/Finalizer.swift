@preconcurrency import AVFoundation
import Foundation
import StenoModel

public enum Finalizer {
    static let blockSamples = 16_000

    public static func trackURL(_ kind: TrackKind, in dir: URL) -> URL {
        dir.appendingPathComponent("\(kind.rawValue).wav")
    }

    /// True when every present track's continuous file exists with the timeline length.
    public static func isFinalized(_ manifest: SessionManifest, at dir: URL) -> Bool {
        let length = manifest.timelineSamples
        return manifest.presentTracks.allSatisfy { kind in
            (try? WAVReader(url: trackURL(kind, in: dir)).sampleCount) == length
        } && manifest.playbackFile.map { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) } == true
    }

    /// Writes `<kind>.wav` (all of equal timeline length) and the playback mix. Idempotent.
    @discardableResult
    public static func finalize(at dir: URL) throws -> SessionManifest {
        var manifest = try ManifestIO.read(from: ManifestIO.url(in: dir))
        let length = manifest.timelineSamples
        var buffer = [Int16](repeating: 0, count: blockSamples)

        for kind in manifest.presentTracks {
            let parts = manifest.parts.filter { $0.kind == kind && $0.sampleCount > 0 }.sorted { $0.offsetSamples < $1.offsetSamples }
            let out = try WAVWriter(url: trackURL(kind, in: dir))
            var position: Int64 = 0
            func zeros(until end: Int64) throws {
                buffer.withUnsafeMutableBufferPointer { $0.update(repeating: 0) }
                while position < end {
                    let n = Int(min(Int64(blockSamples), end - position))
                    try buffer.withUnsafeBufferPointer { try out.append(int16: UnsafeBufferPointer(rebasing: $0[0..<n])) }
                    position += Int64(n)
                }
            }
            for (i, part) in parts.enumerated() {
                let start = max(part.offsetSamples, position)
                let next = i + 1 < parts.count ? parts[i + 1].offsetSamples : Int64.max
                let skip = start - part.offsetSamples
                let usable = max(0, min(part.sampleCount - skip, next - start))
                try zeros(until: start)
                let reader = try WAVReader(url: dir.appendingPathComponent(part.file))
                var copied: Int64 = 0
                while copied < usable {
                    let want = Int(min(Int64(blockSamples), usable - copied))
                    let n = try buffer.withUnsafeMutableBufferPointer {
                        try reader.read(at: skip + copied, count: want, into: $0.baseAddress!)
                    }
                    if n == 0 { break }
                    try buffer.withUnsafeBufferPointer { try out.append(int16: UnsafeBufferPointer(rebasing: $0[0..<n])) }
                    copied += Int64(n)
                    position += Int64(n)
                }
            }
            try zeros(until: length)
            try out.close()
        }

        manifest.playbackFile = try writeMix(manifest, at: dir)
        try ManifestIO.write(manifest, to: ManifestIO.url(in: dir))
        return manifest
    }

    private static func writeMix(_ manifest: SessionManifest, at dir: URL) throws -> String? {
        let tracks = manifest.presentTracks
        guard !tracks.isEmpty else { return nil }
        let fm = FileManager.default
        let m4a = dir.appendingPathComponent("mix.m4a")
        let wav = dir.appendingPathComponent("mix.wav")
        try? fm.removeItem(at: m4a)
        try? fm.removeItem(at: wav)

        let readers = try tracks.map { try WAVReader(url: trackURL($0, in: dir)) }
        let length = readers.map(\.sampleCount).max() ?? 0
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 48_000,
        ]

        var aac: AVAudioFile?
        do {
            aac = try AVAudioFile(forWriting: m4a, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        } catch {
            StenoLog.capture.warning("AAC mix unavailable (\(error.localizedDescription, privacy: .public)); writing mix.wav")
            try? fm.removeItem(at: m4a)
        }
        let pcmOut = aac == nil ? try WAVWriter(url: wav) : nil
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(blockSamples))!
        var scratch = [Int16](repeating: 0, count: blockSamples)

        var position: Int64 = 0
        while position < length {
            let n = Int(min(Int64(blockSamples), length - position))
            let mixed = buffer.floatChannelData![0]
            mixed.update(repeating: 0, count: n)
            for reader in readers {
                let got = try scratch.withUnsafeMutableBufferPointer { try reader.read(at: position, count: n, into: $0.baseAddress!) }
                for i in 0..<got { mixed[i] += Float(scratch[i]) / 32768 }
            }
            for i in 0..<n { mixed[i] = max(-1, min(1, mixed[i])) }
            buffer.frameLength = AVAudioFrameCount(n)
            if let aac {
                try aac.write(from: buffer)
            } else {
                try pcmOut?.append(UnsafeBufferPointer(start: mixed, count: n))
            }
            position += Int64(n)
        }
        try pcmOut?.close()
        return aac == nil ? "mix.wav" : "mix.m4a"
    }
}
