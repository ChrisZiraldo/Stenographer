import Foundation

public enum TrackKind: String, Codable, Sendable, CaseIterable {
    case mic, system, imported = "import"
}

public enum CaptureMode: String, Codable, Sendable, CaseIterable {
    case call, inPerson, systemOnly, imported = "import"

    /// Tracks a session in this mode produces, in canonical order.
    public var tracks: [TrackKind] {
        switch self {
        case .call: [.mic, .system]
        case .inPerson: [.mic]
        case .systemOnly: [.system]
        case .imported: [.imported]
        }
    }

    /// Track whose speakers are diarized.
    public var diarizationTrack: TrackKind {
        switch self {
        case .call, .systemOnly: .system
        case .inPerson: .mic
        case .imported: .imported
        }
    }
}

public enum PartEndReason: String, Codable, Sendable {
    case stopped, deviceChanged, sleep, crash, diskFull, error
}

public enum ManifestState: String, Codable, Sendable {
    case recording, captured
}

public struct CapturePart: Codable, Sendable, Equatable {
    public var index: Int
    public var kind: TrackKind
    /// Path relative to the session directory.
    public var file: String
    public var firstHostTime: UInt64
    /// Offset on the 16 kHz session timeline.
    public var offsetSamples: Int64
    public var sampleCount: Int64
    public var deviceUID: String?
    public var deviceName: String?
    public var nativeSampleRate: Double
    public var endReason: PartEndReason?

    public init(
        index: Int, kind: TrackKind, file: String, firstHostTime: UInt64, offsetSamples: Int64,
        sampleCount: Int64, deviceUID: String?, deviceName: String?, nativeSampleRate: Double,
        endReason: PartEndReason? = nil
    ) {
        self.index = index
        self.kind = kind
        self.file = file
        self.firstHostTime = firstHostTime
        self.offsetSamples = offsetSamples
        self.sampleCount = sampleCount
        self.deviceUID = deviceUID
        self.deviceName = deviceName
        self.nativeSampleRate = nativeSampleRate
        self.endReason = endReason
    }
}

public struct SessionManifest: Codable, Sendable, Equatable {
    public var version: Int = 1
    public var id: UUID
    public var createdAt: Date
    public var mode: CaptureMode
    public var t0HostTime: UInt64
    public var timebaseNumer: UInt32
    public var timebaseDenom: UInt32
    public var state: ManifestState
    public var endedAt: Date?
    public var parts: [CapturePart]
    public var playbackFile: String?

    public init(
        id: UUID, createdAt: Date, mode: CaptureMode, t0HostTime: UInt64, timebaseNumer: UInt32,
        timebaseDenom: UInt32, state: ManifestState, endedAt: Date? = nil, parts: [CapturePart] = [],
        playbackFile: String? = nil
    ) {
        self.id = id
        self.createdAt = createdAt
        self.mode = mode
        self.t0HostTime = t0HostTime
        self.timebaseNumer = timebaseNumer
        self.timebaseDenom = timebaseDenom
        self.state = state
        self.endedAt = endedAt
        self.parts = parts
        self.playbackFile = playbackFile
    }

    /// Tracks that have at least one part, in canonical order.
    public var presentTracks: [TrackKind] {
        TrackKind.allCases.filter { kind in parts.contains { $0.kind == kind } }
    }

    /// Length of the finalized tracks: end of the latest part on the 16 kHz timeline.
    public var timelineSamples: Int64 {
        parts.map { $0.offsetSamples + $0.sampleCount }.max() ?? 0
    }

    public var durationSeconds: Double { Double(timelineSamples) / 16_000 }
}

public struct ASRWord: Codable, Sendable, Equatable {
    public var track: TrackKind
    public var start: Double
    public var end: Double
    public var text: String
    public var confidence: Float

    public init(track: TrackKind, start: Double, end: Double, text: String, confidence: Float) {
        self.track = track
        self.start = start
        self.end = end
        self.text = text
        self.confidence = confidence
    }
}

public struct SpeakerTurn: Codable, Sendable, Equatable {
    public var speaker: String
    public var start: Double
    public var end: Double

    public init(speaker: String, start: Double, end: Double) {
        self.speaker = speaker
        self.start = start
        self.end = end
    }
}

public struct TranscriptSpeaker: Codable, Sendable, Equatable {
    public var id: String
    public var isMe: Bool

    public init(id: String, isMe: Bool) {
        self.id = id
        self.isMe = isMe
    }
}

public struct TranscriptWord: Codable, Sendable, Equatable {
    public var word: ASRWord
    public var speaker: String

    public init(word: ASRWord, speaker: String) {
        self.word = word
        self.speaker = speaker
    }
}

public struct Utterance: Codable, Sendable, Equatable {
    public var speaker: String
    public var track: TrackKind
    public var start: Double
    public var end: Double
    public var text: String

    public init(speaker: String, track: TrackKind, start: Double, end: Double, text: String) {
        self.speaker = speaker
        self.track = track
        self.start = start
        self.end = end
        self.text = text
    }
}

public struct TranscriptDocument: Codable, Sendable, Equatable {
    public var version: Int = 1
    public var runId: UUID
    public var asrModel: String
    /// "pyannote-community-1" or "none".
    public var diarizer: String
    public var diarizationError: String?
    public var speakers: [TranscriptSpeaker]
    public var words: [TranscriptWord]
    public var utterances: [Utterance]

    public init(
        runId: UUID, asrModel: String, diarizer: String, diarizationError: String?,
        speakers: [TranscriptSpeaker], words: [TranscriptWord], utterances: [Utterance]
    ) {
        self.runId = runId
        self.asrModel = asrModel
        self.diarizer = diarizer
        self.diarizationError = diarizationError
        self.speakers = speakers
        self.words = words
        self.utterances = utterances
    }
}

/// 16 kHz mono capture audio starting at `startSample` on the session timeline.
public struct LiveChunk: Sendable {
    public var track: TrackKind
    public var startSample: Int64
    public var samples: [Float]

    public init(track: TrackKind, startSample: Int64, samples: [Float]) {
        self.track = track
        self.startSample = startSample
        self.samples = samples
    }
}

public struct LiveSegment: Codable, Sendable, Equatable {
    public var track: TrackKind
    public var speakerLabel: String
    public var start: Double
    public var end: Double
    public var text: String
    public var latency: Double

    public init(track: TrackKind, speakerLabel: String, start: Double, end: Double, text: String, latency: Double) {
        self.track = track
        self.speakerLabel = speakerLabel
        self.start = start
        self.end = end
        self.text = text
        self.latency = latency
    }
}
