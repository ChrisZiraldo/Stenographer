import CoreAudio
import Foundation

public struct AudioDeviceInfo: Sendable, Identifiable, Hashable {
    public var id: String { uid }
    public var uid: String
    public var name: String
    public var inputChannels: Int
    public var outputChannels: Int
    public var nominalSampleRate: Double
}

public enum DeviceCatalog {
    public static func allDevices() -> [AudioDeviceInfo] {
        let ids = (try? CAProperty.array(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDevices, zero: AudioObjectID(0))) ?? []
        return ids.compactMap { info(for: $0) }
    }

    public static func inputDevices() -> [AudioDeviceInfo] {
        allDevices().filter { $0.inputChannels > 0 && !$0.uid.hasPrefix("CADefaultDeviceAggregate") }
    }

    public static func defaultInput() -> AudioDeviceInfo? {
        CAProperty.defaultDevice(input: true).flatMap(info(for:))
    }

    public static func defaultOutput() -> AudioDeviceInfo? {
        CAProperty.defaultDevice(input: false).flatMap(info(for:))
    }

    static func info(for id: AudioObjectID) -> AudioDeviceInfo? {
        guard let uid = try? CAProperty.string(id, kAudioDevicePropertyDeviceUID) else { return nil }
        return AudioDeviceInfo(
            uid: uid,
            name: (try? CAProperty.string(id, kAudioObjectPropertyName)) ?? uid,
            inputChannels: (try? CAProperty.channelCount(id, scope: kAudioObjectPropertyScopeInput)) ?? 0,
            outputChannels: (try? CAProperty.channelCount(id, scope: kAudioObjectPropertyScopeOutput)) ?? 0,
            nominalSampleRate: (try? CAProperty.value(id, kAudioDevicePropertyNominalSampleRate, initial: Float64(0))) ?? 0)
    }
}
