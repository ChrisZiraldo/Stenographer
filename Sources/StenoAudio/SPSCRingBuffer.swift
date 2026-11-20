import Synchronization

/// Lock-free single-producer/single-consumer Float32 ring. `write` is real-time safe.
public final class SPSCRingBuffer: @unchecked Sendable {
    public static let defaultCapacity = 1 << 19

    public let capacity: Int
    private let mask: Int
    private let storage: UnsafeMutablePointer<Float>
    // Monotonic indices; position = index & mask.
    private let readIndex = Atomic<Int>(0)
    private let writeIndex = Atomic<Int>(0)
    /// Frames the producer could not write; the consumer replaces them with silence.
    public let dropped = Atomic<Int64>(0)

    public init(capacity: Int = SPSCRingBuffer.defaultCapacity) {
        precondition(capacity > 0 && capacity & (capacity - 1) == 0, "capacity must be a power of two")
        self.capacity = capacity
        mask = capacity - 1
        storage = .allocate(capacity: capacity)
        storage.initialize(repeating: 0, count: capacity)
    }

    deinit { storage.deallocate() }

    public var availableToRead: Int {
        writeIndex.load(ordering: .acquiring) - readIndex.load(ordering: .relaxed)
    }

    /// Writes all `count` frames, or nothing (returns false) when there is not enough space.
    @discardableResult
    public func write(_ src: UnsafePointer<Float>, count: Int) -> Bool {
        let w = writeIndex.load(ordering: .relaxed)
        let r = readIndex.load(ordering: .acquiring)
        guard count <= capacity - (w - r) else { return false }
        let start = w & mask
        let first = min(count, capacity - start)
        (storage + start).update(from: src, count: first)
        if first < count { storage.update(from: src + first, count: count - first) }
        writeIndex.store(w + count, ordering: .releasing)
        return true
    }

    /// Reads up to `max` frames into `dst`; returns the number read.
    public func read(into dst: UnsafeMutablePointer<Float>, max: Int) -> Int {
        let r = readIndex.load(ordering: .relaxed)
        let w = writeIndex.load(ordering: .acquiring)
        let n = min(w - r, max)
        guard n > 0 else { return 0 }
        let start = r & mask
        let first = min(n, capacity - start)
        dst.update(from: storage + start, count: first)
        if first < n { (dst + first).update(from: storage, count: n - first) }
        readIndex.store(r + n, ordering: .releasing)
        return n
    }
}
