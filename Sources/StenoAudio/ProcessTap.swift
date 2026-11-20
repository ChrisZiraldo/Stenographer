import CoreAudio
import Foundation

/// Mono global process tap of all system output except this process.
public final class ProcessTap {
    public let tapID: AudioObjectID
    public let uuid: String
    public let format: AudioStreamBasicDescription

    public init() throws {
        var pid = getpid()
        var addr = CAProperty.address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var selfObject = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr, UInt32(MemoryLayout<pid_t>.size), &pid, &size, &selfObject)
        let excluded: [AudioObjectID] = status == noErr && selfObject != kAudioObjectUnknown ? [selfObject] : []

        let description = CATapDescription(monoGlobalTapButExcludeProcesses: excluded)
        description.isPrivate = true
        description.muteBehavior = .unmuted
        description.name = "Stenographer System Audio"

        var id = AudioObjectID(kAudioObjectUnknown)
        let createStatus = AudioHardwareCreateProcessTap(description, &id)
        guard createStatus == noErr else { throw CaptureError.tapCreateFailed(createStatus) }
        tapID = id
        uuid = description.uuid.uuidString
        do {
            format = try CAProperty.value(id, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
        } catch {
            AudioHardwareDestroyProcessTap(id)
            throw error
        }
    }

    deinit { AudioHardwareDestroyProcessTap(tapID) }
}
