import ArgumentParser
import FluidAudio
import Foundation
import StenoModel
import StenoPipeline
import StenoStore

/// Replays a processed session through the live caption path and scores the live speaker labels against
/// the session's offline transcript.
struct LiveReplay: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "live-replay", abstract: "Score live speaker labels against a processed session.")
    @Argument(help: "Session id.") var session: String
    @Option(help: "Data root (default ~/Library/Application Support/Stenographer).") var dataRoot: String?
    @Option(help: "Seconds of audio to skip.") var start: Double = 0
    @Option(help: "Seconds of audio to replay (0 = all).") var duration: Double = 0
    @Option(help: "Replay speed relative to real time.") var speed: Double = 4
    @Flag(help: "Print every segment.") var verbose = false
    @Flag(help: "Skip voice identification (baseline).") var noIdentify = false

    func run() async throws {
        let paths = try dataRoot.map { try AppPaths(root: absoluteURL($0)) } ?? AppPaths()
        let database = try StenoDatabase(paths: paths)
        guard let record = try SessionRepository(database).get(id: session), let runID = record.currentRunId else {
            throw ValidationError("session has no transcript")
        }
        let folder = paths.sessionDirectory(folder: record.folder)
        let wav = ["import.wav", "system.wav"].map { folder.appendingPathComponent($0) }.first {
            FileManager.default.fileExists(atPath: $0.path)
        }
        guard let wav else { throw ValidationError("no import.wav or system.wav") }

        let lines = try RunRepository(database).utterances(runID: runID)
        let known = try SpeakerLibrary(database).all().map {
            KnownVoice(name: $0.name, vector: VoiceVector.vector($0.centroid))
        }
        let knownNames = Set(known.map(\.name))

        var samples = try AudioConverter().resampleAudioFile(wav)
        let from = Int(start * 16_000)
        let to = duration > 0 ? min(samples.count, from + Int(duration * 16_000)) : samples.count
        samples = Array(samples[from..<to])

        let live = LiveTranscriber(
            transcriber: Transcriber(), mode: .call, diarizer: noIdentify ? nil : Diarizer(),
            knownVoices: known)
        try await live.prepare()
        let collector = Task { () -> [LiveSegment] in
            var out: [LiveSegment] = []
            for await segment in live.segments { out.append(segment) }
            return out
        }
        let step = 8_000
        var at = 0
        while at < samples.count {
            let end = min(at + step, samples.count)
            await live.append(LiveChunk(track: .system, startSample: Int64(at), samples: Array(samples[at..<end])))
            try await Task.sleep(for: .seconds(Double(step) / 16_000 / speed))
            at = end
        }
        await live.finish()
        let segments = await collector.value

        score(segments, offset: start, lines: lines, knownNames: knownNames)
    }

    private func score(_ segments: [LiveSegment], offset: Double, lines: [TranscriptLine], knownNames: Set<String>) {
        var correct = 0, wrong = 0, unnamed = 0, mixed = 0, noTruth = 0
        var truthByLabel: [String: [String: Int]] = [:]
        var latencies: [Double] = []
        for s in segments {
            let a = s.start + offset, b = s.end + offset
            var overlap: [String: Double] = [:]
            var name: [String: String] = [:]
            for l in lines {
                let o = min(b, l.end) - max(a, l.start)
                guard o > 0 else { continue }
                overlap[l.speaker.id, default: 0] += o
                name[l.speaker.id] = l.speaker.displayName ?? l.speaker.label
            }
            latencies.append(s.latency)
            let total = overlap.values.reduce(0, +)
            guard let top = overlap.max(by: { $0.value < $1.value }), total > 0 else {
                noTruth += 1
                continue
            }
            let truth = name[top.key] ?? top.key
            let pure = top.value / total >= 0.8
            if verbose {
                print(String(format: "%7.1f  %-14@ truth %-16@ %@%@", a, s.speakerLabel as NSString, truth as NSString, pure ? "" : "[mixed] ", s.text))
            }
            guard pure else {
                mixed += 1
                continue
            }
            truthByLabel[s.speakerLabel, default: [:]][truth, default: 0] += 1
            if knownNames.contains(truth) {
                if s.speakerLabel == truth {
                    correct += 1
                } else if knownNames.contains(s.speakerLabel) {
                    wrong += 1
                } else {
                    unnamed += 1
                }
            }
        }
        print("\nsegments: \(segments.count)  mixed-truth: \(mixed)  no-truth: \(noTruth)")
        print("segments whose true speaker is a saved voice: correct \(correct)  wrong name \(wrong)  unnamed \(unnamed)")
        for (label, truths) in truthByLabel.sorted(by: { $0.key < $1.key }) {
            let total = truths.values.reduce(0, +)
            let top = truths.sorted { $0.value > $1.value }.prefix(3).map { "\($0.key) \($0.value)" }.joined(separator: ", ")
            print("  \(label): \(total) segments — \(top)")
        }
        let sorted = latencies.sorted()
        if let p = sorted.last { print(String(format: "latency (replay speed, not real time) p50 %.1f  max %.1f", sorted[sorted.count / 2], p)) }
    }
}
