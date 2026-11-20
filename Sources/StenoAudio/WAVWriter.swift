import Darwin
import Foundation

public enum WAVError: Error, LocalizedError {
    case io(String, Int32)
    case notCanonical(URL)

    public var errorDescription: String? {
        switch self {
        case .io(let what, let code): "\(what): \(String(cString: strerror(code)))"
        case .notCanonical(let url): "\(url.lastPathComponent) is not a 16 kHz mono Int16 WAV"
        }
    }

    public var isDiskFull: Bool {
        if case .io(_, let code) = self { return code == ENOSPC || code == EDQUOT }
        return false
    }
}

/// Streaming 16 kHz mono Int16 WAV writer whose file stays valid (after `repair`) at any instant.
public final class WAVWriter {
    public static let headerSize = 44
    public static let sampleRate = 16_000
    static let patchInterval: Duration = .seconds(5)

    public let url: URL
    public private(set) var sampleCount: Int64 = 0
    private var fd: Int32
    private var scratch: [Int16]
    private var lastPatch = ContinuousClock.now

    public init(url: URL, scratchCapacity: Int = 16_384) throws {
        self.url = url
        fd = open(url.path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        guard fd >= 0 else { throw WAVError.io("open \(url.lastPathComponent)", errno) }
        scratch = [Int16](repeating: 0, count: scratchCapacity)
        var header = Self.header(dataBytes: 0)
        try header.withUnsafeMutableBytes { try Self.writeAll(fd, $0.baseAddress!, $0.count, "write header") }
    }

    deinit { if fd >= 0 { Darwin.close(fd) } }

    /// Appends Float32 samples (clamped to [-1, 1]).
    public func append(_ samples: UnsafeBufferPointer<Float>) throws {
        var offset = 0
        while offset < samples.count {
            let n = min(scratch.count, samples.count - offset)
            scratch.withUnsafeMutableBufferPointer { out in
                for i in 0..<n {
                    let v = max(-1, min(1, samples[offset + i]))
                    out[i] = Int16(v < 0 ? v * 32768 : v * 32767)
                }
            }
            try scratch.withUnsafeBytes { try Self.writeAll(fd, $0.baseAddress!, n * 2, "write \(url.lastPathComponent)") }
            offset += n
        }
        sampleCount += Int64(samples.count)
        if ContinuousClock.now - lastPatch >= Self.patchInterval { try sync() }
    }

    /// Appends already-quantized Int16 samples.
    public func append(int16 samples: UnsafeBufferPointer<Int16>) throws {
        try Self.writeAll(fd, samples.baseAddress!, samples.count * 2, "write \(url.lastPathComponent)")
        sampleCount += Int64(samples.count)
        if ContinuousClock.now - lastPatch >= Self.patchInterval { try sync() }
    }

    /// Patches the header sizes and fsyncs.
    public func sync() throws {
        try Self.patchHeader(fd, dataBytes: sampleCount * 2)
        guard fsync(fd) == 0 else { throw WAVError.io("fsync", errno) }
        lastPatch = .now
    }

    public func close() throws {
        guard fd >= 0 else { return }
        defer {
            Darwin.close(fd)
            fd = -1
        }
        try sync()
    }

    /// Makes a possibly truncated file valid; returns its sample count. Files without a full header are deleted.
    @discardableResult
    public static func repair(_ url: URL) throws -> Int64 {
        let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
        guard size >= Int64(headerSize) else {
            try FileManager.default.removeItem(at: url)
            return 0
        }
        let dataBytes = (size - Int64(headerSize)) & ~1
        let fd = open(url.path, O_RDWR)
        guard fd >= 0 else { throw WAVError.io("open \(url.lastPathComponent)", errno) }
        defer { Darwin.close(fd) }
        guard ftruncate(fd, off_t(Int64(headerSize) + dataBytes)) == 0 else { throw WAVError.io("truncate", errno) }
        try patchHeader(fd, dataBytes: dataBytes)
        guard fsync(fd) == 0 else { throw WAVError.io("fsync", errno) }
        return dataBytes / 2
    }

    static func header(dataBytes: Int64) -> [UInt8] {
        var h = [UInt8]()
        h.reserveCapacity(headerSize)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { h.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { h.append(contentsOf: $0) } }
        let data = UInt32(clamping: dataBytes)
        h.append(contentsOf: Array("RIFF".utf8)); u32(36 &+ data)
        h.append(contentsOf: Array("WAVE".utf8))
        h.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        h.append(contentsOf: Array("data".utf8)); u32(data)
        return h
    }

    static func patchHeader(_ fd: Int32, dataBytes: Int64) throws {
        let data = UInt32(clamping: dataBytes)
        var riff = (36 &+ data).littleEndian
        var size = data.littleEndian
        guard pwrite(fd, &riff, 4, 4) == 4, pwrite(fd, &size, 4, 40) == 4 else {
            throw WAVError.io("patch header", errno)
        }
    }

    static func writeAll(_ fd: Int32, _ ptr: UnsafeRawPointer, _ count: Int, _ what: @autoclosure () -> String) throws {
        var done = 0
        while done < count {
            let n = Darwin.write(fd, ptr + done, count - done)
            if n < 0 {
                if errno == EINTR { continue }
                throw WAVError.io(what(), errno)
            }
            done += n
        }
    }
}

/// Sequential Int16 sample reader for the canonical 44-byte-header WAVs this package writes.
public final class WAVReader {
    public let url: URL
    public let sampleCount: Int64
    private let fd: Int32

    public init(url: URL) throws {
        self.url = url
        let fd = open(url.path, O_RDONLY)
        guard fd >= 0 else { throw WAVError.io("open \(url.lastPathComponent)", errno) }
        self.fd = fd
        var header = [UInt8](repeating: 0, count: WAVWriter.headerSize)
        let n = header.withUnsafeMutableBytes { pread(fd, $0.baseAddress!, $0.count, 0) }
        func u32(_ at: Int) -> UInt32 {
            UInt32(header[at]) | UInt32(header[at + 1]) << 8 | UInt32(header[at + 2]) << 16 | UInt32(header[at + 3]) << 24
        }
        guard n == WAVWriter.headerSize, header[0..<4].elementsEqual("RIFF".utf8),
            header[36..<40].elementsEqual("data".utf8), header[20] == 1, header[22] == 1, header[34] == 16,
            u32(24) == UInt32(WAVWriter.sampleRate)
        else {
            Darwin.close(fd)
            throw WAVError.notCanonical(url)
        }
        var st = stat()
        fstat(fd, &st)
        sampleCount = (Int64(st.st_size) - Int64(WAVWriter.headerSize)) / 2
    }

    deinit { Darwin.close(fd) }

    /// Reads up to `count` samples starting at `sample` into `dst`; returns the number read.
    public func read(at sample: Int64, count: Int, into dst: UnsafeMutablePointer<Int16>) throws -> Int {
        let available = Int(max(0, min(Int64(count), sampleCount - sample)))
        var done = 0
        while done < available * 2 {
            let n = pread(
                fd, UnsafeMutableRawPointer(dst) + done, available * 2 - done,
                off_t(Int64(WAVWriter.headerSize) + sample * 2) + off_t(done))
            if n < 0 {
                if errno == EINTR { continue }
                throw WAVError.io("read \(url.lastPathComponent)", errno)
            }
            if n == 0 { break }
            done += n
        }
        return done / 2
    }

    public func readAllFloats() throws -> [Float] {
        var ints = [Int16](repeating: 0, count: Int(sampleCount))
        let n = try ints.withUnsafeMutableBufferPointer { try read(at: 0, count: $0.count, into: $0.baseAddress!) }
        return ints.prefix(n).map { Float($0) / 32768 }
    }
}
