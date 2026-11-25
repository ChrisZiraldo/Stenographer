import Foundation
import StenoModel

/// Pure merge of per-track ASR words and diarization turns into a speaker-attributed transcript.
public enum TranscriptMerger {
    public static let meSpeaker = "Me"
    static let nearTurnSeconds = 0.5
    static let utteranceGapSeconds = 1.2
    static let softBreakSeconds = 30.0
    static let hardBreakSeconds = 45.0
    static let echoWindowSeconds = 1.0
    static let echoOverlapRatio = 0.6
    /// How far apart (start to start) a mic word and the system word it echoes can be.
    static let echoWordWindowSeconds = 1.5
    /// A run of echoed words inside a longer mic line must be at least this long to be dropped.
    static let echoRunMinWords = 4

    public static func merge(
        runID: UUID, mode: CaptureMode, asr: [TrackKind: [ASRWord]], turns: [SpeakerTurn], diarizer: String,
        diarizationError: String?, asrModel: String = PipelineConstants.asrModelName
    ) -> TranscriptDocument {
        let target = mode.diarizationTrack
        var words: [TranscriptWord] = []
        var utterances: [Utterance] = []

        let targetWords = (asr[target] ?? []).sorted { $0.start < $1.start }
        let targetSpeakers = assignSpeakers(words: targetWords, turns: turns)
        let attributedTarget = zip(targetWords, targetSpeakers).map { TranscriptWord(word: $0, speaker: $1) }
        words += attributedTarget
        utterances += buildUtterances(attributedTarget)

        if mode == .call, let micWords = asr[.mic] {
            let systemWords = asr[.system] ?? []
            let mic = micWords.sorted { $0.start < $1.start }.map { TranscriptWord(word: $0, speaker: meSpeaker) }
            for utterance in buildUtterances(mic) where !isEcho(utterance, systemWords: systemWords) {
                let inside = mic.filter { $0.word.start >= utterance.start && $0.word.end <= utterance.end }
                // The other person leaking into the mic right before you answer is echo inside a longer line.
                let echoed = echoWordIndices(in: inside.map(\.word), systemWords: systemWords)
                if echoed.isEmpty {
                    utterances.append(utterance)
                    words += inside
                } else {
                    let kept = inside.enumerated().filter { !echoed.contains($0.offset) }.map(\.element)
                    utterances += buildUtterances(kept)
                    words += kept
                }
            }
        }

        utterances.sort { a, b in a.start != b.start ? a.start < b.start : trackOrder(a.track) < trackOrder(b.track) }
        words.sort { a, b in
            a.word.start != b.word.start ? a.word.start < b.word.start : trackOrder(a.word.track) < trackOrder(b.word.track)
        }

        let labels = Set(words.map(\.speaker))
        let speakers = labels.sorted(by: speakerOrder).map { TranscriptSpeaker(id: $0, isMe: $0 == meSpeaker) }
        return TranscriptDocument(
            runId: runID, asrModel: asrModel, diarizer: diarizer, diarizationError: diarizationError,
            speakers: speakers, words: words, utterances: utterances)
    }

    /// Speaker per word by midpoint: containing turn, else a turn within 0.5 s, else the previous
    /// word's speaker, else (first word) the nearest turn; no turns at all → S1.
    static func assignSpeakers(words: [ASRWord], turns: [SpeakerTurn]) -> [String] {
        guard !turns.isEmpty else { return words.map { _ in "S1" } }
        var result: [String] = []
        result.reserveCapacity(words.count)
        for word in words {
            let mid = (word.start + word.end) / 2
            if let containing = turns.first(where: { $0.start <= mid && mid <= $0.end }) {
                result.append(containing.speaker)
                continue
            }
            let nearest = turns.min { distance(mid, $0) < distance(mid, $1) }!
            if distance(mid, nearest) <= nearTurnSeconds {
                result.append(nearest.speaker)
            } else if let previous = result.last {
                result.append(previous)
            } else {
                result.append(nearest.speaker)
            }
        }
        return result
    }

    static func distance(_ t: Double, _ turn: SpeakerTurn) -> Double {
        t < turn.start ? turn.start - t : (t > turn.end ? t - turn.end : 0)
    }

    /// Groups one track's words (sorted by start) into utterances.
    static func buildUtterances(_ words: [TranscriptWord]) -> [Utterance] {
        var result: [Utterance] = []
        var current: [TranscriptWord] = []

        func flush() {
            guard let first = current.first, let last = current.last else { return }
            result.append(
                Utterance(
                    speaker: first.speaker, track: first.word.track, start: first.word.start, end: last.word.end,
                    text: current.map(\.word.text).joined(separator: " ")))
            current.removeAll(keepingCapacity: true)
        }

        for word in words {
            if let first = current.first, let last = current.last {
                let sameSpeaker = word.speaker == first.speaker
                let gap = word.word.start - last.word.end
                let duration = last.word.end - first.word.start
                let softBreak = duration > softBreakSeconds && endsSentence(last.word.text)
                let hardBreak = word.word.end - first.word.start > hardBreakSeconds
                if !sameSpeaker || gap > utteranceGapSeconds || softBreak || hardBreak { flush() }
            }
            current.append(word)
        }
        flush()
        return result
    }

    static func endsSentence(_ text: String) -> Bool {
        guard let last = text.last else { return false }
        return last == "." || last == "?" || last == "!"
    }

    /// A mic utterance is echo when the system track says the same words around the same time.
    static func isEcho(_ utterance: Utterance, systemWords: [ASRWord]) -> Bool {
        let mine = tokens(utterance.text)
        guard !mine.isEmpty else { return false }
        let lo = utterance.start - echoWindowSeconds
        let hi = utterance.end + echoWindowSeconds
        var theirs: [String: Int] = [:]
        for word in systemWords where word.start >= lo && word.start <= hi {
            for token in tokens(word.text) { theirs[token, default: 0] += 1 }
        }
        if mine.count < 3 { return mine.allSatisfy { theirs[$0, default: 0] > 0 } }
        var shared = 0
        for token in mine where theirs[token, default: 0] > 0 {
            theirs[token]! -= 1
            shared += 1
        }
        return Double(shared) / Double(mine.count) >= echoOverlapRatio
    }

    /// Indices of mic words that repeat the system track's words said around the same time, found as runs: at least
    /// `echoRunMinWords` words, never two missing words in a row, and `echoOverlapRatio` of them matched.
    static func echoWordIndices(in micWords: [ASRWord], systemWords: [ASRWord]) -> Set<Int> {
        var candidates: [String: [(start: Double, index: Int)]] = [:]
        for (index, word) in systemWords.enumerated() {
            if let token = tokens(word.text).first { candidates[token, default: []].append((word.start, index)) }
        }
        var used = Set<Int>()
        let matched: [Bool] = micWords.map { word in
            guard let token = tokens(word.text).first else { return false }
            let best = (candidates[token] ?? [])
                .filter { !used.contains($0.index) && abs($0.start - word.start) <= echoWordWindowSeconds }
                .min { abs($0.start - word.start) < abs($1.start - word.start) }
            guard let best else { return false }
            used.insert(best.index)
            return true
        }
        var echoed = Set<Int>()
        var i = 0
        while i < matched.count {
            guard matched[i] else {
                i += 1
                continue
            }
            var last = i
            var misses = 0
            var j = i + 1
            while j < matched.count {
                if matched[j] {
                    last = j
                    misses = 0
                } else {
                    misses += 1
                    if misses > 1 { break }
                }
                j += 1
            }
            let count = last - i + 1
            let hits = matched[i...last].filter { $0 }.count
            if count >= echoRunMinWords, Double(hits) / Double(count) >= echoOverlapRatio { echoed.formUnion(i...last) }
            i = last + 1
        }
        return echoed
    }

    static func tokens(_ text: String) -> [String] {
        text.lowercased().split(whereSeparator: \.isWhitespace).compactMap { raw in
            let kept = String(raw.unicodeScalars.filter { CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) || $0 == "'" })
            return kept.isEmpty ? nil : kept
        }
    }

    static func trackOrder(_ track: TrackKind) -> Int {
        switch track {
        case .mic: 0
        case .system: 1
        case .imported: 2
        }
    }

    static func speakerOrder(_ a: String, _ b: String) -> Bool {
        func key(_ s: String) -> (Int, Int, String) {
            if s == meSpeaker { return (0, 0, s) }
            if s.hasPrefix("S"), let n = Int(s.dropFirst()) { return (1, n, s) }
            return (2, 0, s)
        }
        return key(a) < key(b)
    }
}
