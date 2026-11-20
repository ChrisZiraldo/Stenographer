import Foundation
import StenoAudio
import StenoModel

enum SystemAudioCheck {
    static let settingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture")!

    /// Records 3 s of system audio while another process plays a sound; true when any sample is non-zero.
    /// The tap excludes only this process, so `afplay` is audible to it.
    static func run() async throws -> Bool {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("steno-check-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let session = CaptureSession(
            config: CaptureConfig(mode: .systemOnly, micDeviceUID: nil, sessionDirectory: dir, sessionID: UUID()))
        try await Task.detached { try session.start() }.value

        let player = Process()
        player.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
        player.arguments = ["/System/Library/Sounds/Glass.aiff"]
        try? player.run()
        try await Task.sleep(for: .seconds(3))
        let manifest = try await session.stop()
        if player.isRunning { player.terminate() }

        for part in manifest.parts where part.kind == .system {
            let samples = try WAVReader(url: dir.appendingPathComponent(part.file)).readAllFloats()
            if samples.contains(where: { $0 != 0 }) { return true }
        }
        return false
    }
}
