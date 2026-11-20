import CoreAudio
import Foundation

public enum CaptureError: Error, LocalizedError, Equatable {
    case osStatus(String, OSStatus)
    case tapCreateFailed(OSStatus)
    case aggregateCreateFailed(OSStatus)
    case unexpectedStreamLayout(expected: Int, actual: Int)
    case unsupportedStreamFormat(String)
    case noInputDevice
    case noOutputDevice
    case insufficientDisk(freeBytes: Int64)
    case alreadyStarted
    case notStarted

    public var errorDescription: String? {
        switch self {
        case .osStatus(let what, let status): "\(what) failed (OSStatus \(status))"
        case .tapCreateFailed(let status): "Creating the system audio tap failed (OSStatus \(status))"
        case .aggregateCreateFailed(let status): "Creating the capture device failed (OSStatus \(status))"
        case .unexpectedStreamLayout(let expected, let actual):
            "Capture device has \(actual) input channels, expected \(expected)"
        case .unsupportedStreamFormat(let detail): "Unsupported capture stream format: \(detail)"
        case .noInputDevice: "No microphone available"
        case .noOutputDevice: "No audio output device available"
        case .insufficientDisk(let free): "Not enough free disk space (\(free / 1_000_000) MB free, 2 GB required)"
        case .alreadyStarted: "Capture already started"
        case .notStarted: "Capture not started"
        }
    }
}

/// Thin typed accessors over `AudioObjectGetPropertyData`.
enum CAProperty {
    static func address(
        _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
        _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    }

    static func check(_ status: OSStatus, _ what: @autoclosure () -> String) throws {
        if status != noErr { throw CaptureError.osStatus(what(), status) }
    }

    static func value<T>(
        _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, initial: T
    ) throws -> T {
        var addr = address(selector, scope)
        var result = initial
        var size = UInt32(MemoryLayout<T>.size)
        try check(AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &result), "Get property \(selector)")
        return result
    }

    static func string(
        _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) throws -> String {
        var addr = address(selector, scope)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var result: Unmanaged<CFString>?
        try check(AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &result), "Get string \(selector)")
        guard let result else { return "" }
        return result.takeRetainedValue() as String
    }

    static func array<T>(
        _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, zero: T
    ) throws -> [T] {
        var addr = address(selector, scope)
        var size: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size), "Get size \(selector)")
        let count = Int(size) / MemoryLayout<T>.stride
        var result = [T](repeating: zero, count: count)
        try check(AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &result), "Get array \(selector)")
        return Array(result.prefix(Int(size) / MemoryLayout<T>.stride))
    }

    /// Total channel count of `kAudioDevicePropertyStreamConfiguration` in `scope`.
    static func channelCount(_ device: AudioObjectID, scope: AudioObjectPropertyScope) throws -> Int {
        try bufferChannelCounts(device, scope: scope).reduce(0, +)
    }

    /// Channel count of each buffer in the device's stream configuration, in IOProc buffer order.
    static func bufferChannelCounts(_ device: AudioObjectID, scope: AudioObjectPropertyScope) throws -> [Int] {
        var addr = address(kAudioDevicePropertyStreamConfiguration, scope)
        var size: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size), "Get stream configuration size")
        guard size > 0 else { return [] }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        try check(AudioObjectGetPropertyData(device, &addr, 0, nil, &size, raw), "Get stream configuration")
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.map { Int($0.mNumberChannels) }
    }

    static func deviceID(forUID uid: String) -> AudioObjectID? {
        let devices = (try? array(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDevices, zero: AudioObjectID(0))) ?? []
        return devices.first { (try? string($0, kAudioDevicePropertyDeviceUID)) == uid }
    }

    static func defaultDevice(input: Bool) -> AudioObjectID? {
        let selector = input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice
        let id = (try? value(AudioObjectID(kAudioObjectSystemObject), selector, initial: AudioObjectID(0))) ?? 0
        return id == kAudioObjectUnknown ? nil : id
    }
}
