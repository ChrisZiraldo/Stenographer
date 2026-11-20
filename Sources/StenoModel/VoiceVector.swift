import Foundation

/// Speaker-embedding math shared by the voice library and live speaker identification.
public enum VoiceVector {
    /// Maximum cosine distance for a recognition. Measured on 11 real recordings: the same voice across
    /// meetings sits at 0.03–0.16, different people at ≥ 0.35.
    public static let matchThreshold: Float = 0.25
    /// A voice whose runner-up library voice is closer than this to its best match is left unnamed.
    public static let ambiguityMargin: Float = 0.05

    /// A voice at least this far from every known voice and live speaker is a new person. Between `matchThreshold`
    /// and this, the voice is too uncertain to name or to count as someone new.
    public static let newSpeakerDistance: Float = 0.35

    public static func normalized(_ v: [Float]) -> [Float] {
        var sum: Float = 0
        for x in v { sum += x * x }
        let norm = sum.squareRoot()
        return norm > 0 ? v.map { $0 / norm } : v
    }

    /// 1 − cosine similarity, in [0, 2]; 2 for empty, zero-length or mismatched vectors so they never match.
    public static func cosineDistance(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count, !a.isEmpty else { return 2 }
        var dot: Float = 0, na: Float = 0, nb: Float = 0
        for i in 0..<a.count {
            dot += a[i] * b[i]
            na += a[i] * a[i]
            nb += b[i] * b[i]
        }
        guard na > 0, nb > 0 else { return 2 }
        return 1 - dot / (na * nb).squareRoot()
    }

    public static func data(_ v: [Float]) -> Data { v.withUnsafeBufferPointer { Data(buffer: $0) } }

    public static func vector(_ data: Data) -> [Float] {
        let n = data.count / MemoryLayout<Float>.size
        return [Float](unsafeUninitializedCapacity: n) { buffer, count in
            data.copyBytes(to: UnsafeMutableRawBufferPointer(buffer))
            count = n
        }
    }
}

/// A saved voice the live captions can name.
public struct KnownVoice: Codable, Sendable, Equatable {
    public var name: String
    public var vector: [Float]

    public init(name: String, vector: [Float]) {
        self.name = name
        self.vector = VoiceVector.normalized(vector)
    }
}
