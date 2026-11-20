import AppKit
import SwiftUI

@main
struct StenographerApp: App {
    @State private var model: AppModel?
    @State private var startupError: String?

    init() {
        do {
            let model = try AppModel()
            _model = State(initialValue: model)
            Task { await model.launch() }
        } catch {
            _startupError = State(initialValue: error.localizedDescription)
        }
    }

    var body: some Scene {
        WindowGroup("Stenographer", id: "main") {
            if let model {
                LibraryView(model: model)
                    .frame(minWidth: 820, minHeight: 520)
            } else {
                ContentUnavailableView(
                    "Stenographer could not start", systemImage: "exclamationmark.triangle",
                    description: Text(startupError ?? ""))
                    .frame(minWidth: 480, minHeight: 240)
            }
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("Import Audio…") { model?.importAudio() }
                    .keyboardShortcut("o")
                    .disabled(model == nil)
            }
            CommandGroup(after: .saveItem) {
                Button("Export Markdown…") { model?.exportMarkdown() }
                    .keyboardShortcut("e")
                    .disabled(model?.session(id: model?.selection) == nil)
            }
        }

        MenuBarExtra {
            if let model { MenuBarView(model: model) }
        } label: {
            Image(systemName: model?.recorder.isRecording == true ? "waveform.circle.fill" : "waveform")
        }
        .menuBarExtraStyle(.window)

        Settings {
            if let model { SettingsView(model: model) }
        }
    }
}

enum Format {
    static func duration(_ seconds: Double) -> String {
        let s = Int(seconds.rounded())
        return s >= 3600
            ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    static func timestamp(_ seconds: Double) -> String {
        let s = Int(seconds)
        return String(format: "%02d:%02d", s / 60, s % 60)
    }
}
