import CoreAudio
import Foundation

/// Private aggregate of one clock sub-device (mic or output device) plus an optional process tap.
public final class AggregateDevice {
    public let deviceID: AudioObjectID
    public let clockDeviceUID: String
    public let clockDeviceName: String
    /// Input channels contributed by the clock device; they come first in IOProc buffer order.
    public let clockInputChannels: Int
    public let hasTap: Bool
    /// Channel count of each IOProc input buffer.
    public let bufferChannels: [Int]
    public let sampleRate: Double

    public static func create(clockDeviceUID: String, tapUUID: String?) throws -> AggregateDevice {
        guard let clockID = CAProperty.deviceID(forUID: clockDeviceUID) else { throw CaptureError.noInputDevice }
        let clockChannels = try CAProperty.channelCount(clockID, scope: kAudioObjectPropertyScopeInput)
        let clockName = (try? CAProperty.string(clockID, kAudioObjectPropertyName)) ?? clockDeviceUID

        let tapList: [[String: Any]] = tapUUID.map { [[kAudioSubTapUIDKey: $0, kAudioSubTapDriftCompensationKey: true]] } ?? []
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Stenographer Capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceMainSubDeviceKey: clockDeviceUID,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: clockDeviceUID]],
            kAudioAggregateDeviceTapListKey: tapList,
            kAudioAggregateDeviceTapAutoStartKey: true,
        ]
        var id = AudioObjectID(kAudioObjectUnknown)
        let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &id)
        guard status == noErr else { throw CaptureError.aggregateCreateFailed(status) }

        do {
            let buffers = try CAProperty.bufferChannelCounts(id, scope: kAudioObjectPropertyScopeInput)
            let expected = clockChannels + (tapUUID == nil ? 0 : 1)
            let actual = buffers.reduce(0, +)
            guard actual == expected else { throw CaptureError.unexpectedStreamLayout(expected: expected, actual: actual) }
            try Self.verifyFloatStreams(id)
            let rate = try CAProperty.value(id, kAudioDevicePropertyNominalSampleRate, initial: Float64(0))
            return AggregateDevice(
                deviceID: id, clockDeviceUID: clockDeviceUID, clockDeviceName: clockName,
                clockInputChannels: clockChannels, hasTap: tapUUID != nil, bufferChannels: buffers, sampleRate: rate)
        } catch {
            AudioHardwareDestroyAggregateDevice(id)
            throw error
        }
    }

    private init(
        deviceID: AudioObjectID, clockDeviceUID: String, clockDeviceName: String, clockInputChannels: Int,
        hasTap: Bool, bufferChannels: [Int], sampleRate: Double
    ) {
        self.deviceID = deviceID
        self.clockDeviceUID = clockDeviceUID
        self.clockDeviceName = clockDeviceName
        self.clockInputChannels = clockInputChannels
        self.hasTap = hasTap
        self.bufferChannels = bufferChannels
        self.sampleRate = sampleRate
    }

    deinit { AudioHardwareDestroyAggregateDevice(deviceID) }

    private static func verifyFloatStreams(_ device: AudioObjectID) throws {
        let streams = try CAProperty.array(
            device, kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput, zero: AudioObjectID(0))
        for stream in streams {
            let asbd = try CAProperty.value(stream, kAudioStreamPropertyVirtualFormat, initial: AudioStreamBasicDescription())
            let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
            guard asbd.mFormatID == kAudioFormatLinearPCM, isFloat, asbd.mBitsPerChannel == 32 else {
                throw CaptureError.unsupportedStreamFormat(
                    "format \(asbd.mFormatID) flags \(asbd.mFormatFlags) bits \(asbd.mBitsPerChannel)")
            }
        }
    }
}
