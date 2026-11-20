import AppKit
import StenoStore
import SwiftUI

/// Formatted notes (bold, italic, underline, font, size, color, alignment) with debounced autosave;
/// also saves on disappear and app termination. Stored as RTF, with the plain text kept for search and AI notes.
struct NotesView: View {
    let model: AppModel
    let session: SessionRecord
    @State private var controller = RichTextController()
    @State private var dirty = false
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
            RichTextToolbar(controller: controller)
            Divider()
            RichTextEditor(controller: controller)
                .padding(8)
                .overlay(alignment: .topLeading) {
                    if controller.isEmpty {
                        Text("Type notes…").foregroundStyle(.tertiary).padding(.horizontal, 15).padding(.vertical, 16).allowsHitTesting(false)
                    }
                }
        }
        .onAppear(perform: load)
        .onDisappear(perform: saveNow)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in saveNow() }
    }

    private func load() {
        let notes = NoteRepository(model.database)
        do {
            controller.setContent(plain: try notes.body(sessionID: session.id), rtf: try notes.richText(sessionID: session.id))
        } catch {
            saveError = error.localizedDescription
        }
        controller.onChange = {
            guard loaded else { return }
            dirty = true
            scheduleSave()
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
        guard loaded, dirty else { return }
        let (plain, rtf) = controller.snapshot()
        do {
            try NoteRepository(model.database).save(sessionID: session.id, body: plain, richText: rtf)
            dirty = false
            saveError = nil
        } catch {
            saveError = error.localizedDescription
            scheduleSave()
        }
    }
}
