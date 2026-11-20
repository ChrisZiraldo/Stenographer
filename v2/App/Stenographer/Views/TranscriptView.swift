import StenoModel
import StenoStore
import SwiftUI

struct TranscriptView: View {
    let model: AppModel
    let session: SessionRecord
    let playback: PlaybackController
    @State private var lines: [TranscriptLine] = []
    @State private var speakers: [SpeakerRecord] = []
    @State private var run: RunRecord?
    @State private var follow = true
    @State private var renaming: SpeakerRecord?
    @State private var newName = ""
    @State private var canRemember = false
    @State private var remember = true

    static let palette: [Color] = [.blue, .green, .orange, .purple, .pink, .teal, .brown, .indigo]

    private var currentLineID: Int64? {
        lines.last { $0.start <= playback.currentTime }?.id
    }

    var body: some View {
        Group {
            if lines.isEmpty {
                ContentUnavailableView(
                    session.status == .ready ? "No Speech Found" : "Transcript Not Ready", systemImage: "text.bubble",
                    description: Text(session.status == .ready ? "The recording contains no recognizable speech." : "The transcript appears when processing finishes."))
            } else {
                transcript
            }
        }
        .task(id: session.currentRunId) { reload() }
        .sheet(item: $renaming) { speaker in
            VStack(alignment: .leading, spacing: 12) {
                Text("Rename \(speaker.name)").font(.headline)
                TextField("Name", text: $newName).onSubmit { commitRename(speaker) }
                if canRemember {
                    Toggle("Remember this voice for future meetings", isOn: $remember)
                }
                HStack {
                    Spacer()
                    Button("Cancel") { renaming = nil }.keyboardShortcut(.cancelAction)
                    Button("Rename") { commitRename(speaker) }.keyboardShortcut(.defaultAction)
                }
            }
            .padding()
            .frame(width: 320)
        }
    }

    private var transcript: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                if let error = run?.diarizationError {
                    Label("Diarization unavailable: \(error)", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                Spacer()
                Toggle("Follow playback", isOn: $follow).toggleStyle(.checkbox)
            }
            .font(.callout)
            .padding(.horizontal)
            .padding(.bottom, 4)
            ScrollViewReader { proxy in
                List(lines) { line in
                    row(line)
                        .listRowBackground(line.id == currentLineID ? Color.accentColor.opacity(0.15) : Color.clear)
                        .contentShape(Rectangle())
                        .onTapGesture { playback.seek(to: line.start) }
                        .id(line.id)
                }
                .onChange(of: currentLineID) {
                    if follow, playback.isPlaying, let id = currentLineID {
                        withAnimation { proxy.scrollTo(id, anchor: .center) }
                    }
                }
            }
        }
    }

    private func row(_ line: TranscriptLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("[\(Format.timestamp(line.start))]").monospacedDigit().foregroundStyle(.secondary)
            speakerChip(line.speaker)
            Text(line.text).textSelection(.enabled)
        }
        .padding(.vertical, 2)
    }

    private func speakerChip(_ speaker: SpeakerRecord) -> some View {
        Menu {
            Button("Rename…") {
                newName = speaker.displayName ?? ""
                canRemember = SpeakerLibrary(model.database).canRemember(speakerID: speaker.id)
                remember = true
                renaming = speaker
            }
            if speaker.autoMatched {
                Button("Not \(speaker.name)") { clearName(speaker) }
            }
            Menu("Merge into") {
                ForEach(speakers.filter { $0.id != speaker.id }) { other in
                    Button(other.name) { merge(speaker, into: other) }
                }
            }
            .disabled(speakers.count < 2)
        } label: {
            HStack(spacing: 3) {
                Text(speaker.name)
                if speaker.autoMatched { Image(systemName: "checkmark.seal.fill").imageScale(.small) }
            }
            .font(.callout.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(color(speaker).opacity(0.2), in: Capsule())
            .foregroundStyle(color(speaker))
            .help(speaker.autoMatched ? "Recognized from your speaker library" : "")
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .fixedSize()
    }

    private func color(_ speaker: SpeakerRecord) -> Color {
        speaker.isMe ? .accentColor : Self.palette[speaker.colorIndex % Self.palette.count]
    }

    private func reload() {
        guard let runID = session.currentRunId else {
            lines = []
            speakers = []
            run = nil
            return
        }
        let runs = RunRepository(model.database)
        do {
            run = try runs.run(id: runID)
            speakers = try runs.speakers(runID: runID)
            lines = try runs.utterances(runID: runID)
        } catch {
            model.alert = "Transcript could not be loaded: \(error.localizedDescription)"
        }
    }

    private func commitRename(_ speaker: SpeakerRecord) {
        do {
            try RunRepository(model.database).renameSpeaker(id: speaker.id, displayName: newName)
            if canRemember, remember, !newName.trimmingCharacters(in: .whitespaces).isEmpty {
                try SpeakerLibrary(model.database).rememberVoice(ofSpeaker: speaker.id, as: newName)
            }
        } catch {
            model.alert = error.localizedDescription
        }
        renaming = nil
        reload()
    }

    private func clearName(_ speaker: SpeakerRecord) {
        do {
            try RunRepository(model.database).renameSpeaker(id: speaker.id, displayName: "")
        } catch {
            model.alert = error.localizedDescription
        }
        reload()
    }

    private func merge(_ source: SpeakerRecord, into target: SpeakerRecord) {
        do {
            try RunRepository(model.database).mergeSpeaker(source: source.id, into: target.id)
        } catch {
            model.alert = error.localizedDescription
        }
        reload()
    }
}
