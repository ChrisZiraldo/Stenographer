import FluidAudio
import Foundation
import StenoAudio
import StenoModel

/// Provisional captions: Silero VAD per track → Parakeet per speech segment.
public actor LiveTranscriber {
    static let sampleRate = 16_000
    static let prerollSamples = 2 * 16_000
    static let leadInSamples = Int64(0.2 * 16_000)
    static let maxSegmentSamples = 14 * 16_000
    static let minimumASRSamples = 16_000
    static let maxPending = 4
    static let maxConsecutiveErrors = 5

    public nonisolated let segments: AsyncStream<LiveSegment>
    private let continuation: AsyncStream<LiveSegment>.Continuation
    private let transcriber: Transcriber
    private let mode: CaptureMode
    private var vad: VadManager?
    private var vadFailed = false
    private var tracks: [TrackKind: TrackState] = [:]
    private var queue: [Segment] = []
    private var drainTask: Task<Void, Never>?
    private var consecutiveErrors = 0
    private var stopped = false
    /// Wall-clock time of session sample 0, estimated from the least-delayed chunk arrival.
    private var wallStart = Date.distantFuture

    struct Segment {
        var track: TrackKind
        var start: Int64
        var samples: [Float]
    }

    struct TrackState {
        var vad: VadStreamState
        var buffer: [Float] = []
        var origin: Int64
        var fed: Int64
        var history: [Float] = []
        var historyStart: Int64
        var segmentStart: Int64?

        var historyEnd: Int64 { historyStart + Int64(history.count) }
    }

    public init(transcriber: Transcriber, mode: CaptureMode) {
        self.transcriber = transcriber
        self.mode = mode
        (segments, continuation) = AsyncStream.makeStream(of: LiveSegment.self)
    }

    public func prepare() async throws {
        if vad == nil { vad = try await VadManager(config: VadConfig(defaultThreshold: 0.75)) }
        try await transcriber.prepare()
    }

    public func append(_ chunk: LiveChunk) async {
        guard !stopped, !chunk.samples.isEmpty else { return }
        let chunkEnd = chunk.startSample + Int64(chunk.samples.count)
        let estimate = Date().addingTimeInterval(-Double(chunkEnd) / Double(Self.sampleRate))
        if estimate < wallStart { wallStart = estimate }

        if vad == nil, !vadFailed {
            do { try await prepare() } catch {
                vadFailed = true
                StenoLog.live.error("Live captions unavailable: \(error.localizedDescription, privacy: .public)")
            }
        }
        guard let vad else { return }

        let fresh = TrackState(
            vad: VadStreamState.initial(), origin: chunk.startSample, fed: chunk.startSample,
            historyStart: chunk.startSample)
        var state = tracks[chunk.track] ?? fresh
        if chunk.startSample != state.historyEnd {
            // Discontinuity (part rotation or dropped chunks): close any open segment and restart the stream.
            closeSegment(&state, track: chunk.track, at: state.historyEnd)
            state = fresh
        }
        state.history += chunk.samples
        state.buffer += chunk.samples

        while state.buffer.count >= VadManager.chunkSize {
            let window = Array(state.buffer.prefix(VadManager.chunkSize))
            state.buffer.removeFirst(VadManager.chunkSize)
            state.fed += Int64(VadManager.chunkSize)
            do {
                let result = try await vad.processStreamingChunk(
                    window, state: state.vad, config: .default, returnSeconds: true, timeResolution: 2)
                state.vad = result.state
                if let event = result.event {
                    let at = state.origin + Int64(event.sampleIndex)
                    switch event.kind {
                    case .speechStart:
                        if state.segmentStart == nil { state.segmentStart = max(at - Self.leadInSamples, state.historyStart) }
                    case .speechEnd:
                        closeSegment(&state, track: chunk.track, at: min(at, state.fed))
                    }
                }
            } catch {
                StenoLog.live.error("VAD failed: \(error.localizedDescription, privacy: .public)")
            }
            if let start = state.segmentStart, state.fed - start >= Int64(Self.maxSegmentSamples) {
                closeSegment(&state, track: chunk.track, at: start + Int64(Self.maxSegmentSamples))
                state.segmentStart = start + Int64(Self.maxSegmentSamples)
            }
        }
        trimHistory(&state)
        tracks[chunk.track] = state
    }

    /// Flushes open segments, waits for pending transcriptions and ends `segments`.
    public func finish() async {
        for (track, var state) in tracks {
            closeSegment(&state, track: track, at: state.historyEnd)
            tracks[track] = state
        }
        while let task = drainTask { await task.value }
        stopped = true
        continuation.finish()
    }

    private func closeSegment(_ state: inout TrackState, track: TrackKind, at end: Int64) {
        guard let start = state.segmentStart else { return }
        state.segmentStart = nil
        let lo = Int(max(start, state.historyStart) - state.historyStart)
        let hi = Int(min(end, state.historyEnd) - state.historyStart)
        guard hi > lo else { return }
        enqueue(Segment(track: track, start: start, samples: Array(state.history[lo..<hi])))
    }

    private func trimHistory(_ state: inout TrackState) {
        let keepFrom = min(state.segmentStart ?? Int64.max, state.historyEnd - Int64(Self.prerollSamples))
        let drop = Int(keepFrom - state.historyStart)
        // Trim in bulk to keep removal amortized.
        if drop > Self.prerollSamples {
            state.history.removeFirst(drop)
            state.historyStart += Int64(drop)
        }
    }

    private func enqueue(_ segment: Segment) {
        guard !stopped else { return }
        queue.append(segment)
        if queue.count > Self.maxPending {
            let dropped = queue.count - Self.maxPending
            queue.removeFirst(dropped)
            StenoLog.live.warning("Live captions behind; dropped \(dropped) segments")
        }
        if drainTask == nil { drainTask = Task { await drain() } }
    }

    private func drain() async {
        while !queue.isEmpty, !stopped {
            let segment = queue.removeFirst()
            var samples = segment.samples
            if samples.count < Self.minimumASRSamples {
                samples += [Float](repeating: 0, count: Self.minimumASRSamples - samples.count)
            }
            do {
                let result = try await transcriber.transcribe(samples: samples)
                consecutiveErrors = 0
                let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                let start = Double(segment.start) / Double(Self.sampleRate)
                let end = start + Double(segment.samples.count) / Double(Self.sampleRate)
                continuation.yield(
                    LiveSegment(
                        track: segment.track, speakerLabel: label(for: segment.track), start: start, end: end,
                        text: text, latency: Date().timeIntervalSince(wallStart.addingTimeInterval(end))))
            } catch {
                consecutiveErrors += 1
                StenoLog.live.error("Live ASR failed: \(error.localizedDescription, privacy: .public)")
                if consecutiveErrors >= Self.maxConsecutiveErrors {
                    StenoLog.live.error("Live captions stopped after \(Self.maxConsecutiveErrors) consecutive errors")
                    stopped = true
                    queue.removeAll()
                    continuation.finish()
                }
            }
        }
        drainTask = nil
    }

    private func label(for track: TrackKind) -> String {
        switch track {
        case .mic: mode == .inPerson ? "Room" : "Me"
        case .system, .imported: "Others"
        }
    }
}
