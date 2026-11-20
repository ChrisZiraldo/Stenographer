import CoreAudio
import Foundation
import Synchronization

/// Runs the aggregate's IOProc and splits its input into the mic and system rings.
/// The IOProc block allocates nothing, takes no locks and does not log.
final class IOProcBridge: @unchecked Sendable {
    static let scratchFrames = 8192

    let aggregate: AggregateDevice
    let micRing: SPSCRingBuffer?
    let systemRing: SPSCRingBuffer?
    /// `mHostTime` of the first callback's input; 0 until the first callback.
    let firstHostTime = Atomic<UInt64>(0)
    let framesDelivered = Atomic<Int64>(0)

    private let micScratch: UnsafeMutablePointer<Float>
    private let silence: UnsafeMutablePointer<Float>
    private let queue = DispatchQueue(label: "steno.ioproc", qos: .userInteractive)
    private var procID: AudioDeviceIOProcID?
    private var running = false

    init(aggregate: AggregateDevice, micRing: SPSCRingBuffer?, systemRing: SPSCRingBuffer?) {
        self.aggregate = aggregate
        self.micRing = micRing
        self.systemRing = systemRing
        micScratch = .allocate(capacity: Self.scratchFrames)
        micScratch.initialize(repeating: 0, count: Self.scratchFrames)
        silence = .allocate(capacity: Self.scratchFrames)
        silence.initialize(repeating: 0, count: Self.scratchFrames)
    }

    deinit {
        stop()
        micScratch.deallocate()
        silence.deallocate()
    }

    func start() throws {
        let micChannels = aggregate.clockInputChannels
        let hasTap = aggregate.hasTap
        let micRing = micRing
        let systemRing = systemRing
        let micScratch = micScratch
        let silence = silence
        let scratchFrames = Self.scratchFrames

        var id: AudioDeviceIOProcID?
        // unowned(unsafe): `stop()` destroys the IOProc before `self` can go away; avoids refcounting on the RT thread.
        let status = AudioDeviceCreateIOProcIDWithBlock(&id, aggregate.deviceID, queue) {
            [unowned(unsafe) self] _, inInputData, inInputTime, _, _ in
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            guard buffers.count > 0 else { return }
            let first = buffers[0]
            let firstChannels = max(Int(first.mNumberChannels), 1)
            let frames = Int(first.mDataByteSize) / (MemoryLayout<Float>.size * firstChannels)
            guard frames > 0 else { return }

            // Published to the writer by the ring's releasing store below.
            if inInputTime.pointee.mFlags.contains(.hostTimeValid) {
                _ = self.firstHostTime.compareExchange(expected: 0, desired: inInputTime.pointee.mHostTime, ordering: .relaxed)
            }

            // Mic: average the first `micChannels` channels across the leading buffers.
            if let micRing {
                var start = 0
                while start < frames {
                    let n = min(scratchFrames, frames - start)
                    micScratch.update(repeating: 0, count: n)
                    var channelsSeen = 0
                    var b = 0
                    while b < buffers.count && channelsSeen < micChannels {
                        let buf = buffers[b]
                        let ch = Int(buf.mNumberChannels)
                        if let data = buf.mData?.assumingMemoryBound(to: Float.self) {
                            let use = min(ch, micChannels - channelsSeen)
                            for i in 0..<n {
                                let base = (start + i) * ch
                                var sum: Float = 0
                                for c in 0..<use { sum += data[base + c] }
                                micScratch[i] += sum
                            }
                        }
                        channelsSeen += ch
                        b += 1
                    }
                    if micChannels > 1 {
                        let scale = 1 / Float(micChannels)
                        for i in 0..<n { micScratch[i] *= scale }
                    }
                    if !micRing.write(micScratch, count: n) {
                        micRing.dropped.add(Int64(n), ordering: .relaxed)
                    }
                    start += n
                }
            }

            // System: the single tap channel follows the clock device's channels.
            if let systemRing {
                var tapData: UnsafeMutablePointer<Float>?
                var tapStride = 1
                if hasTap {
                    var channelsSeen = 0
                    for buf in buffers {
                        let ch = Int(buf.mNumberChannels)
                        if channelsSeen >= micChannels {
                            tapData = buf.mData?.assumingMemoryBound(to: Float.self)
                            tapStride = max(ch, 1)
                            break
                        }
                        channelsSeen += ch
                    }
                }
                var start = 0
                while start < frames {
                    let n = min(scratchFrames, frames - start)
                    let src: UnsafePointer<Float>
                    if let tapData, tapStride == 1 {
                        src = UnsafePointer(tapData + start)
                    } else if let tapData {
                        for i in 0..<n { micScratch[i] = tapData[(start + i) * tapStride] }
                        src = UnsafePointer(micScratch)
                    } else {
                        src = UnsafePointer(silence)
                    }
                    if !systemRing.write(src, count: n) {
                        systemRing.dropped.add(Int64(n), ordering: .relaxed)
                    }
                    start += n
                }
            }
            self.framesDelivered.add(Int64(frames), ordering: .releasing)
        }
        guard status == noErr, let id else { throw CaptureError.osStatus("AudioDeviceCreateIOProcIDWithBlock", status) }
        procID = id
        let startStatus = AudioDeviceStart(aggregate.deviceID, id)
        guard startStatus == noErr else {
            AudioDeviceDestroyIOProcID(aggregate.deviceID, id)
            procID = nil
            throw CaptureError.osStatus("AudioDeviceStart", startStatus)
        }
        running = true
    }

    /// Stops the IOProc; returns once no callback is running.
    func stop() {
        guard let procID else { return }
        if running { AudioDeviceStop(aggregate.deviceID, procID) }
        AudioDeviceDestroyIOProcID(aggregate.deviceID, procID)
        // Drain any callback already queued on the IOProc queue.
        queue.sync {}
        self.procID = nil
        running = false
    }
}
