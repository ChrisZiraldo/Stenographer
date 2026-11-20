import AVFoundation
import Foundation
import Testing

@testable import StenoAudio
import StenoModel

func makeTempDir() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("steno-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

func writeWAV(_ url: URL, samples: [Int16]) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let w = try WAVWriter(url: url)
    try samples.withUnsafeBufferPointer { try w.append(int16: $0) }
    try w.close()
}

@Suite struct RingBufferTests {
    @Test func wrapsAroundPreservingOrder() {
        let ring = SPSCRingBuffer(capacity: 8)
        var out = [Float](repeating: 0, count: 8)
        let a: [Float] = [1, 2, 3, 4, 5, 6]
        #expect(ring.write(a, count: 6))
        #expect(out.withUnsafeMutableBufferPointer { ring.read(into: $0.baseAddress!, max: 4) } == 4)
        let b: [Float] = [7, 8, 9, 10, 11]
        #expect(ring.write(b, count: 5))  // wraps
        let n = out.withUnsafeMutableBufferPointer { ring.read(into: $0.baseAddress!, max: 8) }
        #expect(n == 7)
        #expect(Array(out.prefix(7)) == [5, 6, 7, 8, 9, 10, 11])
    }

    @Test func overflowWritesNothing() {
        let ring = SPSCRingBuffer(capacity: 8)
        let a = [Float](repeating: 1, count: 6)
        #expect(ring.write(a, count: 6))
        #expect(!ring.write(a, count: 3))
        #expect(ring.availableToRead == 6)
        var out = [Float](repeating: 0, count: 8)
        #expect(out.withUnsafeMutableBufferPointer { ring.read(into: $0.baseAddress!, max: 8) } == 6)
    }
}

@Suite struct WAVWriterTests {
    @Test func repairRecoversUnclosedFile() throws {
        let dir = try makeTempDir()
        let url = dir.appendingPathComponent("a.wav")
        let w = try WAVWriter(url: url)
        let samples = [Float](repeating: 0.25, count: 48_000)
        try samples.withUnsafeBufferPointer { try w.append($0) }
        // Simulated crash: no close(); header still says 0 bytes.
        #expect(try WAVWriter.repair(url) == 48_000)
        #expect(try AVAudioFile(forReading: url).length == 48_000)
        _ = w
    }

    @Test func repairDeletesHeaderlessFile() throws {
        let dir = try makeTempDir()
        let url = dir.appendingPathComponent("short.wav")
        try Data(repeating: 0, count: 30).write(to: url)
        #expect(try WAVWriter.repair(url) == 0)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func repairDropsOddTrailingByte() throws {
        let dir = try makeTempDir()
        let url = dir.appendingPathComponent("odd.wav")
        try writeWAV(url, samples: [1, 2, 3])
        let h = try FileHandle(forWritingTo: url)
        try h.seekToEnd()
        try h.write(contentsOf: Data([7]))
        try h.close()
        #expect(try WAVWriter.repair(url) == 3)
        #expect(try WAVReader(url: url).sampleCount == 3)
    }
}

@Suite struct HostTimeTests {
    @Test func oneSecondIs16000Samples() {
        let t0: UInt64 = 1_000_000
        #expect(HostTime.samples16k(from: t0, to: t0 + HostTime.ticks(fromSeconds: 1)) == 16_000)
        #expect(HostTime.samples16k(from: t0 + HostTime.ticks(fromSeconds: 1), to: t0) == -16_000)
    }
}

@Suite struct ManifestTests {
    @Test func roundTrips() throws {
        let dir = try makeTempDir()
        let m = SessionManifest(
            id: UUID(), createdAt: Date(timeIntervalSince1970: 1_800_000_000), mode: .call, t0HostTime: 42,
            timebaseNumer: 125, timebaseDenom: 3, state: .recording,
            parts: [
                CapturePart(
                    index: 1, kind: .mic, file: "raw/mic-001.wav", firstHostTime: 42, offsetSamples: 0, sampleCount: 9,
                    deviceUID: "X", deviceName: "Mic", nativeSampleRate: 48_000, endReason: .deviceChanged)
            ])
        let url = ManifestIO.url(in: dir)
        try ManifestIO.write(m, to: url)
        try ManifestIO.write(m, to: url)  // replace path
        #expect(try ManifestIO.read(from: url) == m)
    }
}

@Suite struct FinalizerTests {
    @Test func fillsGapsAndEqualizesTracks() throws {
        let dir = try makeTempDir()
        var parts: [CapturePart] = []
        for kind in [TrackKind.mic, .system] {
            for (index, offset) in [(1, Int64(0)), (2, Int64(32_000))] {
                let file = "raw/\(kind.rawValue)-00\(index).wav"
                try writeWAV(dir.appendingPathComponent(file), samples: [Int16](repeating: 1000, count: 16_000))
                parts.append(
                    CapturePart(
                        index: index, kind: kind, file: file, firstHostTime: 0, offsetSamples: offset, sampleCount: 16_000,
                        deviceUID: nil, deviceName: nil, nativeSampleRate: 48_000, endReason: .stopped))
            }
        }
        let m = SessionManifest(
            id: UUID(), createdAt: Date(), mode: .call, t0HostTime: 1, timebaseNumer: 1, timebaseDenom: 1, state: .captured,
            parts: parts)
        try ManifestIO.write(m, to: ManifestIO.url(in: dir))

        let out = try Finalizer.finalize(at: dir)
        let mic = try WAVReader(url: dir.appendingPathComponent("mic.wav")).readAllFloats()
        let system = try WAVReader(url: dir.appendingPathComponent("system.wav")).readAllFloats()
        #expect(mic.count == 48_000)
        #expect(system.count == 48_000)
        #expect(mic[16_000..<32_000].allSatisfy { $0 == 0 })
        #expect(mic[0..<16_000].allSatisfy { $0 != 0 })
        #expect(mic[32_000..<48_000].allSatisfy { $0 != 0 })
        #expect(out.playbackFile != nil)
        #expect(Finalizer.isFinalized(out, at: dir))
    }
}

@Suite struct TrackWriterTests {
    /// Identical frame counts per callback (with drops on one track) must yield equal-length parts.
    @Test func equalInputGivesEqualLengthParts() throws {
        let dir = try makeTempDir()
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("raw"), withIntermediateDirectories: true)
        func part(_ kind: TrackKind) -> CapturePart {
            CapturePart(
                index: 1, kind: kind, file: "raw/\(kind.rawValue)-001.wav", firstHostTime: 0, offsetSamples: 0,
                sampleCount: 0, deviceUID: nil, deviceName: nil, nativeSampleRate: 48_000)
        }
        let micRing = SPSCRingBuffer(capacity: 1 << 12)
        let systemRing = SPSCRingBuffer(capacity: 1 << 14)
        let mic = try TrackWriter(kind: .mic, ring: micRing, part: part(.mic), sessionDirectory: dir)
        let system = try TrackWriter(kind: .system, ring: systemRing, part: part(.system), sessionDirectory: dir)

        var rng = SystemRandomNumberGenerator()
        let block = [Float](repeating: 0.1, count: 4096)
        var total = 0
        for step in 0..<400 {
            let frames = Int.random(in: 1...1024, using: &rng)
            total += frames
            for ring in [micRing, systemRing] where !ring.write(block, count: frames) {
                ring.dropped.add(Int64(frames), ordering: .relaxed)
            }
            if step % 7 == 0 { try system.drain() }
            if step % 13 == 0 { try mic.drain() }  // mic ring overflows in between
        }
        let a = try mic.finish(reason: .stopped)
        let b = try system.finish(reason: .stopped)
        #expect(a.sampleCount == b.sampleCount)
        #expect(abs(Double(a.sampleCount) - Double(total) / 3) < 50)
    }
}
