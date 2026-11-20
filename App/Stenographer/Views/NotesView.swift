import AppKit
import StenoStore
import SwiftUI

/// Plain-text Markdown notes with debounced autosave; also saves on disappear and app termination.
struct NotesView: View {
    let model: AppModel
    let session: SessionRecord
    @State private var text = ""
    @State private var savedText = ""
    @State private var loaded = false
    @State private var saveTask: Task<Void, Never>?
    @State private var saveError: String?

    var body: some View {
        VStack(spacing: 0) {
            if let saveError {
                Label("Notes not saved: \(saveError) — retrying", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                    .background(.red)
            }
            TextEditor(text: $text)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(8)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Type notes in Markdown…").foregroundStyle(.tertiary).padding(14).allowsHitTesting(false)
                    }
                }
        }
        .onAppear(perform: load)
        .onChange(of: text) {
            guard loaded else { return }
            scheduleSave()
        }
        .onDisappear(perform: saveNow)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in saveNow() }
    }

    private func load() {
        do {
            text = try NoteRepository(model.database).body(sessionID: session.id)
            savedText = text
        } catch {
            saveError = error.localizedDescription
        }
        loaded = true
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            saveNow()
        }
    }

    private func saveNow() {
        guard loaded, text != savedText else { return }
        do {
            try NoteRepository(model.database).save(sessionID: session.id, body: text)
            savedText = text
            saveError = nil
        } catch {
            saveError = error.localizedDescription
            scheduleSave()
        }
    }
}
