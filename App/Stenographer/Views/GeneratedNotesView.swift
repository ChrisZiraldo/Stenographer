import AppKit
import MarkdownUI
import StenoNotes
import StenoStore
import SwiftUI

struct GeneratedNotesView: View {
    let model: AppModel
    let session: SessionRecord
    @AppStorage("notes.templateID") private var templateID = "general"
    @State private var history: [GeneratedNoteRecord] = []
    @State private var selectedID: String?
    @State private var streaming: String?
    @State private var task: Task<Void, Never>?
    @State private var error: String?

    private var shown: String? {
        streaming ?? history.first { $0.id == selectedID }?.bodyMd ?? history.first?.bodyMd
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Picker("Template", selection: $templateID) {
                    ForEach(NoteTemplate.all) { Text($0.name).tag($0.id) }
                }
                .fixedSize()
                if task == nil {
                    Button("Generate", action: generate)
                        .disabled(session.status != .ready)
                        .help(session.status == .ready ? "Generate notes from the transcript" : "Transcript not ready")
                } else {
                    Button("Stop") { stop() }
                    ProgressView().controlSize(.small)
                }
                Spacer()
                if !history.isEmpty, streaming == nil {
                    Picker("Version", selection: Binding(get: { selectedID ?? history.first?.id }, set: { selectedID = $0 })) {
                        ForEach(history) { note in
                            Text("\(note.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(NoteTemplate.named(note.templateId)?.name ?? note.templateId) · \(note.provider)/\(note.model)")
                                .tag(Optional(note.id))
                        }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(shown ?? "", forType: .string)
                } label: { Label("Copy Markdown", systemImage: "doc.on.doc") }
                    .disabled(shown == nil)
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
            if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).padding(.horizontal)
            }
            ScrollView {
                if let shown {
                    Markdown(shown)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                } else {
                    ContentUnavailableView(
                        "No Generated Notes", systemImage: "sparkles",
                        description: Text("Generate structured notes from the transcript and your notes."))
                }
            }
        }
        .onAppear(perform: reload)
        .onDisappear { stop() }
    }

    private func reload() {
        history = (try? NoteRepository(model.database).generated(sessionID: session.id)) ?? []
    }

    private func generate() {
        error = nil
        let provider: any LLMProvider
        do { provider = try model.makeLLMProvider() } catch {
            self.error = error.localizedDescription
            return
        }
        let template = NoteTemplate.named(templateID) ?? NoteTemplate.all[0]
        let stream = NoteGenerator(database: model.database).generate(sessionID: session.id, template: template, provider: provider)
        streaming = ""
        task = Task {
            do {
                for try await delta in stream { streaming = (streaming ?? "") + delta }
                reload()
                selectedID = history.first?.id
            } catch is CancellationError {
            } catch {
                self.error = "Generation failed: \(error.localizedDescription)"
            }
            streaming = nil
            task = nil
        }
    }

    private func stop() {
        task?.cancel()
        task = nil
        streaming = nil
    }
}
