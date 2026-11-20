import AVFoundation
import SwiftUI

struct OnboardingView: View {
    let model: AppModel
    @AppStorage(SettingsKey.onboardingCompleted) private var completed = false
    @Environment(\.dismiss) private var dismiss
    @State private var micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
    @State private var systemAudio: SystemAudioState = .unknown

    enum SystemAudioState: Equatable {
        case unknown, testing, granted, notDetected
        case failed(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Set up Stenographer").font(.title2.bold())
            Text("Stenographer records your microphone and your Mac's audio, then transcribes everything on this Mac.")
                .foregroundStyle(.secondary)

            step(1, "Microphone", done: micStatus == .authorized) {
                switch micStatus {
                case .authorized: Label("Allowed", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                case .notDetermined:
                    Button("Allow Microphone") {
                        Task {
                            _ = await AVCaptureDevice.requestAccess(for: .audio)
                            micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
                        }
                    }
                default:
                    HStack {
                        Text("Denied").foregroundStyle(.orange)
                        Button("Open Settings") {
                            NSWorkspace.shared.open(
                                URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
                        }
                    }
                }
            }

            step(2, "System Audio", done: systemAudio == .granted) {
                VStack(alignment: .leading, spacing: 6) {
                    switch systemAudio {
                    case .unknown:
                        Button("Test system audio") { test() }
                    case .testing:
                        ProgressView().controlSize(.small)
                    case .granted:
                        Label("Detected", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    case .notDetected, .failed:
                        if case .failed(let message) = systemAudio { Text(message).foregroundStyle(.orange) }
                        Text("Not detected — enable Stenographer under System Settings → Privacy & Security → Screen & System Audio Recording")
                            .fixedSize(horizontal: false, vertical: true)
                        HStack {
                            Button("Open Settings") { NSWorkspace.shared.open(SystemAudioCheck.settingsURL) }
                            Button("Test again") { test() }
                        }
                    }
                }
            }

            HStack {
                Spacer()
                Button("Later") { dismiss() }
                Button("Done") {
                    completed = true
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(micStatus != .authorized || systemAudio != .granted)
            }
        }
        .padding(24)
        .frame(width: 520)
    }

    private func step(_ n: Int, _ title: String, done: Bool, @ViewBuilder content: () -> some View) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: done ? "checkmark.circle.fill" : "\(n).circle")
                .font(.title2)
                .foregroundStyle(done ? .green : .secondary)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline)
                content()
            }
        }
    }

    private func test() {
        systemAudio = .testing
        Task {
            do {
                systemAudio = try await SystemAudioCheck.run() ? .granted : .notDetected
            } catch {
                systemAudio = .failed(error.localizedDescription)
            }
        }
    }
}
