import CoreAudio
import Foundation
import StenoModel

public struct CaptureConfig: Sendable {
    public var mode: CaptureMode
    /// nil or empty follows the system default input.
    public var micDeviceUID: String?
    public var sessionDirectory: URL
    public var sessionID: UUID
    /// Emit 16 kHz chunks on `liveAudio`.
    public var liveAudio: Bool

    public init(mode: CaptureMode, micDeviceUID: String?, sessionDirectory: URL, sessionID: UUID, liveAudio: Bool = false) {
        self.mode = mode
        self.micDeviceUID = micDeviceUID
        self.sessionDirectory = sessionDirectory
        self.sessionID = sessionID
        self.liveAudio = liveAudio
    }
}

public struct Levels: Sendable {
    public var micDBFS: Float?
    public var systemDBFS: Float?

    public init(micDBFS: Float?, systemDBFS: Float?) {
        self.micDBFS = micDBFS
        self.systemDBFS = systemDBFS
    }
}

public enum CaptureEvent: Sendable {
    case partStarted(CapturePart)
    case partEnded(index: Int, reason: PartEndReason)
    case overrun(TrackKind, Int64)
    case systemAudioSilent(seconds: Int)
    case diskLow(freeBytes: Int64)
    case stoppedForDiskFull
    case error(String)
}

/// Records mic and/or system audio into crash-safe, sample-aligned 16 kHz WAV parts.
///
/// Threading: `control` owns the tap, aggregate, IOProc and lifecycle; `writer` owns the track
/// writers and the manifest. `control` may `sync` onto `writer`, never the reverse.
public final class CaptureSession: @unchecked Sendable {
    public static let minimumStartFreeBytes: Int64 = 2_000_000_000
    public static let minimumRunningFreeBytes: Int64 = 500_000_000
    static let silentTapSeconds = 30

    public let config: CaptureConfig
    public let levels: AsyncStream<Levels>
    public let liveAudio: AsyncStream<LiveChunk>
    public let events: AsyncStream<CaptureEvent>
    private let levelsContinuation: AsyncStream<Levels>.Continuation
    private let liveContinuation: AsyncStream<LiveChunk>.Continuation
    private let eventsContinuation: AsyncStream<CaptureEvent>.Continuation

    private let control = DispatchQueue(label: "steno.capture.control")
    private let writer = DispatchQueue(label: "steno.writer", qos: .userInitiated)
    private let micRing: SPSCRingBuffer?
    private let systemRing: SPSCRingBuffer?

    // control-confined
    private enum Phase { case idle, running, asleep, rebuilding, halted, stopped }
    private var phase = Phase.idle
    private var tap: ProcessTap?
    private var bridge: IOProcBridge?
    private var monitor: DeviceMonitor?
    private var diskTimer: DispatchSourceTimer?
    private var stoppedManifest: SessionManifest?

    // writer-confined
    private var manifest: SessionManifest
    private var activeBridge: IOProcBridge?
    private var generation = 0
    private var writers: [TrackWriter] = []
    private var writerTimer: DispatchSourceTimer?
    private var levelAccumulators: [TrackKind: (sumSquares: Double, count: Int)] = [:]
    private var lastLevelEmit = ContinuousClock.now
    private var systemZeroRun: Int64 = 0
    private var silentReported = false
    private var writerFailed = false

    public init(config: CaptureConfig) {
        self.config = config
        (levels, levelsContinuation) = AsyncStream.makeStream(of: Levels.self, bufferingPolicy: .bufferingNewest(1))
        (liveAudio, liveContinuation) = AsyncStream.makeStream(of: LiveChunk.self, bufferingPolicy: .bufferingNewest(500))
        (events, eventsContinuation) = AsyncStream.makeStream(of: CaptureEvent.self)
        let tracks = config.mode.tracks
        micRing = tracks.contains(.mic) ? SPSCRingBuffer() : nil
        systemRing = tracks.contains(.system) ? SPSCRingBuffer() : nil
        let timebase = HostTime.timebase
        manifest = SessionManifest(
            id: config.sessionID, createdAt: Date(), mode: config.mode, t0HostTime: 0,
            timebaseNumer: timebase.numer, timebaseDenom: timebase.denom, state: .recording)
    }

    // MARK: - Public API

    /// Writes the manifest (state `.recording`) and starts capture.
    public func start() throws {
        precondition(config.mode != .imported, "import sessions are not captured")
        try control.sync {
            guard phase == .idle else { throw CaptureError.alreadyStarted }
            let fm = FileManager.default
            try fm.createDirectory(
                at: config.sessionDirectory.appendingPathComponent("raw"), withIntermediateDirectories: true)
            let free = Self.freeBytes(at: config.sessionDirectory)
            guard free >= Self.minimumStartFreeBytes else { throw CaptureError.insufficientDisk(freeBytes: free) }
            try writer.sync { try writeManifest() }

            if config.mode != .inPerson { tap = try ProcessTap() }
            monitor = DeviceMonitor(queue: control) { [weak self] in self?.handle($0) }
            do {
                try buildEngine()
            } catch {
                monitor = nil
                tap = nil
                throw error
            }
            phase = .running
            startWriterTimer()
            startDiskTimer()
        }
    }

    /// Ends the current parts, closes all files and marks the manifest captured. Safe to call after a halt.
    public func stop() async throws -> SessionManifest {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<SessionManifest, Error>) in
            control.async { [self] in
                if let stoppedManifest { return cont.resume(returning: stoppedManifest) }
                guard phase != .idle else { return cont.resume(throwing: CaptureError.notStarted) }
                if bridge != nil { teardownEngine(reason: .stopped) }
                phase = .stopped
                diskTimer?.cancel()
                diskTimer = nil
                monitor = nil
                tap = nil
                let result: Result<SessionManifest, Error> = writer.sync {
                    writerTimer?.cancel()
                    writerTimer = nil
                    manifest.state = .captured
                    manifest.endedAt = Date()
                    return Result { try writeManifest(); return manifest }
                }
                levelsContinuation.finish()
                liveContinuation.finish()
                eventsContinuation.finish()
                switch result {
                case .success(let m):
                    stoppedManifest = m
                    cont.resume(returning: m)
                case .failure(let error):
                    cont.resume(throwing: error)
                }
            }
        }
    }

    // MARK: - Engine (control queue)

    private func buildEngine() throws {
        let clockUID: String
        var followDefaultInput = false
        switch config.mode {
        case .call, .inPerson:
            if let uid = config.micDeviceUID, !uid.isEmpty, CAProperty.deviceID(forUID: uid) != nil {
                clockUID = uid
            } else {
                if let uid = config.micDeviceUID, !uid.isEmpty {
                    StenoLog.capture.warning("Mic \(uid, privacy: .public) unavailable; using default input")
                }
                guard let id = CAProperty.defaultDevice(input: true) else { throw CaptureError.noInputDevice }
                clockUID = try CAProperty.string(id, kAudioDevicePropertyDeviceUID)
                followDefaultInput = true
            }
        case .systemOnly:
            guard let id = CAProperty.defaultDevice(input: false) else { throw CaptureError.noOutputDevice }
            clockUID = try CAProperty.string(id, kAudioDevicePropertyDeviceUID)
        case .imported:
            preconditionFailure()
        }

        let aggregate = try AggregateDevice.create(clockDeviceUID: clockUID, tapUUID: tap?.uuid)
        let bridge = IOProcBridge(aggregate: aggregate, micRing: micRing, systemRing: systemRing)
        writer.sync {
            generation += 1
            activeBridge = bridge
        }
        do {
            try bridge.start()
        } catch {
            writer.sync { activeBridge = nil }
            throw error
        }
        self.bridge = bridge
        if let clockID = CAProperty.deviceID(forUID: clockUID) {
            monitor?.watchDevices(
                clockDevice: clockID, aggregate: aggregate.deviceID, followDefaultInput: followDefaultInput,
                followDefaultOutput: config.mode == .systemOnly)
        }
        StenoLog.capture.info(
            "Capture engine up: clock \(aggregate.clockDeviceName, privacy: .public) \(aggregate.sampleRate) Hz, buffers \(aggregate.bufferChannels, privacy: .public)"
        )
    }

    private func teardownEngine(reason: PartEndReason) {
        monitor?.unwatchDevices()
        bridge?.stop()
        writer.sync { finishParts(reason: reason) }
        bridge = nil
    }

    private func handle(_ event: DeviceMonitor.Event) {
        switch (event, phase) {
        case (.sleep, .running):
            StenoLog.capture.info("Sleep: ending parts")
            teardownEngine(reason: .sleep)
            phase = .asleep
        case (.wake, .asleep), (.wake, .rebuilding):
            rebuild(attempt: 1)
        case (.deviceChanged, .running):
            StenoLog.capture.info("Device change: rotating parts")
            teardownEngine(reason: .deviceChanged)
            rebuild(attempt: 1)
        default:
            break
        }
    }

    private func rebuild(attempt: Int) {
        guard phase == .running || phase == .asleep || phase == .rebuilding else { return }
        phase = .rebuilding
        do {
            try buildEngine()
            phase = .running
        } catch {
            StenoLog.capture.error("Rebuild \(attempt) failed: \(error.localizedDescription, privacy: .public)")
            if attempt < 3 {
                control.asyncAfter(deadline: .now() + 1) { [weak self] in
                    guard let self, self.phase == .rebuilding else { return }
                    self.rebuild(attempt: attempt + 1)
                }
            } else {
                eventsContinuation.yield(.error("Capture device unavailable: \(error.localizedDescription)"))
                halt(reason: .error)
            }
        }
    }

    /// Ends capture without finalizing the manifest; `stop()` completes it.
    private func halt(reason: PartEndReason) {
        guard phase != .halted, phase != .stopped else { return }
        if bridge != nil { teardownEngine(reason: reason) }
        phase = .halted
        diskTimer?.cancel()
        diskTimer = nil
        if reason == .diskFull { eventsContinuation.yield(.stoppedForDiskFull) }
    }

    private func startDiskTimer() {
        let timer = DispatchSource.makeTimerSource(queue: control)
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let free = Self.freeBytes(at: self.config.sessionDirectory)
            if free < Self.minimumRunningFreeBytes {
                self.eventsContinuation.yield(.diskLow(freeBytes: free))
                self.halt(reason: .diskFull)
            }
        }
        timer.resume()
        diskTimer = timer
    }

    static func freeBytes(at url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage ?? 0
    }

    // MARK: - Writer queue

    private func startWriterTimer() {
        writer.sync {
            let timer = DispatchSource.makeTimerSource(queue: writer)
            timer.schedule(deadline: .now() + .milliseconds(10), repeating: .milliseconds(10), leeway: .milliseconds(2))
            timer.setEventHandler { [weak self] in self?.tick() }
            timer.resume()
            writerTimer = timer
        }
    }

    private func tick() {
        guard !writerFailed, let bridge = activeBridge else { return emitLevelsIfDue() }
        do {
            if writers.isEmpty {
                guard bridge.framesDelivered.load(ordering: .acquiring) > 0 else { return }
                try openParts(bridge)
            }
            for w in writers {
                let dropped = try w.drain()
                if dropped > 0 {
                    StenoLog.capture.error("Overrun on \(w.kind.rawValue, privacy: .public): \(dropped) frames")
                    eventsContinuation.yield(.overrun(w.kind, dropped))
                }
            }
        } catch {
            writerFailed(error)
        }
        emitLevelsIfDue()
    }

    private func writerFailed(_ error: Error) {
        writerFailed = true
        let reason: PartEndReason = (error as? WAVError)?.isDiskFull == true ? .diskFull : .error
        StenoLog.capture.error("Writer failed: \(error.localizedDescription, privacy: .public)")
        eventsContinuation.yield(.error("Writing audio failed: \(error.localizedDescription)"))
        control.async { [weak self] in self?.halt(reason: reason) }
    }

    private func openParts(_ bridge: IOProcBridge) throws {
        var host = bridge.firstHostTime.load(ordering: .relaxed)
        if host == 0 { host = HostTime.now() }
        if manifest.t0HostTime == 0 { manifest.t0HostTime = host }
        let offset = HostTime.samples16k(from: manifest.t0HostTime, to: host)
        for kind in config.mode.tracks {
            guard let ring = kind == .mic ? micRing : systemRing else { continue }
            let part = CapturePart(
                index: generation, kind: kind, file: String(format: "raw/%@-%03d.wav", kind.rawValue, generation),
                firstHostTime: host, offsetSamples: offset, sampleCount: 0,
                deviceUID: kind == .mic ? bridge.aggregate.clockDeviceUID : nil,
                deviceName: kind == .mic ? bridge.aggregate.clockDeviceName : "System Audio",
                nativeSampleRate: bridge.aggregate.sampleRate)
            let w = try TrackWriter(kind: kind, ring: ring, part: part, sessionDirectory: config.sessionDirectory)
            w.onConverted = { [unowned self] samples, start in self.consume(kind: kind, samples: samples, start: start) }
            writers.append(w)
            manifest.parts.append(part)
            eventsContinuation.yield(.partStarted(part))
        }
        try writeManifest()
    }

    private func finishParts(reason: PartEndReason) {
        defer {
            writers = []
            activeBridge = nil
            writerFailed = false
        }
        guard !writers.isEmpty else { return }
        let index = writers[0].part.index
        for w in writers {
            let part: CapturePart
            do {
                part = try w.finish(reason: reason)
            } catch {
                StenoLog.capture.error("Finishing \(w.part.file, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                var p = w.part
                p.sampleCount = w.wav.sampleCount
                p.endReason = reason
                part = p
            }
            if let i = manifest.parts.firstIndex(where: { $0.index == part.index && $0.kind == part.kind }) {
                manifest.parts[i] = part
            }
        }
        do { try writeManifest() } catch {
            StenoLog.capture.error("Manifest write failed: \(error.localizedDescription, privacy: .public)")
        }
        eventsContinuation.yield(.partEnded(index: index, reason: reason))
    }

    private func consume(kind: TrackKind, samples: UnsafeBufferPointer<Float>, start: Int64) {
        var sumSquares: Double = 0
        var allZero = true
        for s in samples {
            sumSquares += Double(s * s)
            if s != 0 { allZero = false }
        }
        var acc = levelAccumulators[kind] ?? (0, 0)
        acc.sumSquares += sumSquares
        acc.count += samples.count
        levelAccumulators[kind] = acc

        if kind == .system, !silentReported {
            systemZeroRun = allZero ? systemZeroRun + Int64(samples.count) : 0
            if systemZeroRun >= Int64(Self.silentTapSeconds * WAVWriter.sampleRate) {
                silentReported = true
                eventsContinuation.yield(.systemAudioSilent(seconds: Self.silentTapSeconds))
            }
        }
        if config.liveAudio {
            liveContinuation.yield(LiveChunk(track: kind, startSample: start, samples: Array(samples)))
        }
    }

    private func emitLevelsIfDue() {
        let now = ContinuousClock.now
        guard now - lastLevelEmit >= .milliseconds(100) else { return }
        lastLevelEmit = now
        func dbfs(_ kind: TrackKind) -> Float? {
            guard let acc = levelAccumulators[kind], acc.count > 0 else { return nil }
            let rms = (acc.sumSquares / Double(acc.count)).squareRoot()
            return Float(max(-100, 20 * log10(max(rms, 1e-10))))
        }
        levelsContinuation.yield(Levels(micDBFS: dbfs(.mic), systemDBFS: dbfs(.system)))
        levelAccumulators.removeAll(keepingCapacity: true)
    }

    private func writeManifest() throws {
        try ManifestIO.write(manifest, to: ManifestIO.url(in: config.sessionDirectory))
    }
}
