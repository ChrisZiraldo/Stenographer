import Foundation
import GRDB
import StenoModel

public enum SessionStatus: String, Codable, Sendable, CaseIterable {
    case recording, captured, processing, ready, failed

    static let allowedTransitions: Set<[SessionStatus]> = [
        [.recording, .captured], [.captured, .processing], [.processing, .ready], [.processing, .failed],
        [.failed, .processing], [.ready, .processing],
    ]

    public func canTransition(to next: SessionStatus) -> Bool {
        Self.allowedTransitions.contains([self, next])
    }
}

public struct SessionRecord: StenoRecord, Identifiable, Equatable, Hashable {
    public static let databaseTableName = "session"
    public var id: String
    public var title: String
    public var createdAt: Date
    public var endedAt: Date?
    public var mode: CaptureMode
    public var status: SessionStatus
    public var durationSec: Double
    public var starred: Bool
    public var folder: String
    public var lastError: String?
    public var currentRunId: String?

    public init(
        id: String, title: String = "", createdAt: Date, endedAt: Date? = nil, mode: CaptureMode, status: SessionStatus,
        durationSec: Double = 0, starred: Bool = false, folder: String, lastError: String? = nil, currentRunId: String? = nil
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.endedAt = endedAt
        self.mode = mode
        self.status = status
        self.durationSec = durationSec
        self.starred = starred
        self.folder = folder
        self.lastError = lastError
        self.currentRunId = currentRunId
    }
}

extension CaptureMode: DatabaseValueConvertible {}
extension SessionStatus: DatabaseValueConvertible {}
extension TrackKind: DatabaseValueConvertible {}

public enum JobState: String, Codable, Sendable, DatabaseValueConvertible {
    case queued, running, done, failed
}

public struct JobRecord: StenoRecord, Identifiable, Equatable {
    public static let databaseTableName = "job"
    public var id: Int64?
    public var sessionId: String
    public var kind: String
    public var state: JobState
    public var attempts: Int
    public var lastError: String?
    public var createdAt: Date
    public var updatedAt: Date

    public mutating func didInsert(_ inserted: InsertionSuccess) { id = inserted.rowID }
}

public struct RunRecord: StenoRecord, Identifiable, Equatable {
    public static let databaseTableName = "run"
    public var id: String
    public var sessionId: String
    public var createdAt: Date
    public var asrModel: String
    public var diarizer: String
    public var diarizationError: String?
}

public struct SpeakerRecord: StenoRecord, Identifiable, Equatable, Hashable {
    public static let databaseTableName = "speaker"
    public var id: String
    public var runId: String
    public var label: String
    public var displayName: String?
    public var isMe: Bool
    public var colorIndex: Int
    /// The library voice this speaker was linked to (by recognition or by "remember this voice").
    public var knownSpeakerId: String?
    /// True when `displayName` was assigned by voice recognition rather than typed by the user.
    public var autoMatched: Bool

    public init(
        id: String, runId: String, label: String, displayName: String?, isMe: Bool, colorIndex: Int,
        knownSpeakerId: String? = nil, autoMatched: Bool = false
    ) {
        self.id = id
        self.runId = runId
        self.label = label
        self.displayName = displayName
        self.isMe = isMe
        self.colorIndex = colorIndex
        self.knownSpeakerId = knownSpeakerId
        self.autoMatched = autoMatched
    }

    public var name: String { displayName ?? label }
}

public struct UtteranceRecord: StenoRecord, Identifiable, Equatable {
    public static let databaseTableName = "utterance"
    public var id: Int64?
    public var runId: String
    public var speakerId: String
    public var track: TrackKind
    public var startSec: Double
    public var endSec: Double
    public var text: String

    public mutating func didInsert(_ inserted: InsertionSuccess) { id = inserted.rowID }
}

/// Utterance joined with its speaker.
public struct TranscriptLine: Sendable, Identifiable, Equatable {
    public var id: Int64
    public var start: Double
    public var end: Double
    public var text: String
    public var track: TrackKind
    public var speaker: SpeakerRecord

    public init(id: Int64, start: Double, end: Double, text: String, track: TrackKind, speaker: SpeakerRecord) {
        self.id = id
        self.start = start
        self.end = end
        self.text = text
        self.track = track
        self.speaker = speaker
    }
}
