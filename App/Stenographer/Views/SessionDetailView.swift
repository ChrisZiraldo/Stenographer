import StenoModel
import StenoStore
import SwiftUI

enum DetailTab: String, CaseIterable, Identifiable {
    case live = "Live"
    case rightNow = "Right now"
    case transcript = "Transcript"
    case notes = "Notes"
    case generated = "Generated"
    var id: String { rawValue }

    static let recording: [DetailTab] = [.live, .rightNow, .notes]
    static let finished: [DetailTab] = [.transcript, .notes, .generated]
}

struct SessionDetailView: View {
    let model: AppModel
    let session: SessionRecord
    @State private var title = ""
    @FocusState private var titleFocused: Bool
    @State private var tab = DetailTab.transcript
    @State private var playback = PlaybackController()

    private var isLive: Bool { model.recorder.active?.sessionID == session.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Untitled", text: $title)
                    .textFieldStyle(.plain)
                    .font(.title2.weight(.semibold))
                    .focused($titleFocused)
                    .onSubmit { commitTitle() }
                statusLine
                if !isLive, playback.isAvailable { PlaybackBar(playback: playback) }
            }
            .padding()
            Divider()
            let tabs = isLive ? DetailTab.recording : DetailTab.finished
            Picker("", selection: $tab) {
                ForEach(tabs) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .padding(8)
            switch tabs.contains(tab) ? tab : tabs[0] {
            case .live: LiveCaptionsView(segments: model.recorder.liveSegments)
            case .rightNow: RightNowView(model: model)
            case .transcript: TranscriptView(model: model, session: session, playback: playback)
            case .notes: NotesView(model: model, session: session)
            case .generated: GeneratedNotesView(model: model, session: session)
            }
        }
        .onAppear {
            title = session.title
            tab = isLive ? .live : .transcript
            loadPlayback()
        }
        // Save a typed name as soon as the field loses focus or the tab changes, not only on Return, so
        // generating notes never sees the meeting as untitled.
        .onChange(of: titleFocused) { if !titleFocused { commitTitle() } }
        .onChange(of: tab) { commitTitle() }
        .onChange(of: isLive) { tab = isLive ? .live : .transcript }
        .onChange(of: session.status) { loadPlayback() }
        .onChange(of: session.title) { title = session.title }
        .onDisappear {
            if title != session.title { model.setTitle(session, title) }
            playback.stop()
        }
    }

    @ViewBuilder private var statusLine: some View {
        HStack(spacing: 8) {
            Text(session.createdAt.formatted(date: .complete, time: .shortened))
            Text("·")
            Text(Format.duration(session.durationSec)).monospacedDigit()
            Text("·")
            Text(modeLabel(session.mode))
            if session.status != .ready {
                Text("·")
                StatusBadge(
                    status: session.status,
                    progress: model.processing?.sessionID == session.id ? model.processing?.fraction : nil)
            }
            if session.status == .failed {
                Text(session.lastError ?? "").foregroundStyle(.orange).lineLimit(2)
                Button("Retry") { Task { await model.reprocess(session) } }
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }

    private func commitTitle() {
        if title != session.title { model.setTitle(session, title) }
    }

    private func loadPlayback() {
        let dir = model.sessionDirectory(session)
        let file = (try? ManifestIO.read(from: ManifestIO.url(in: dir)))?.playbackFile
        playback.load(file.map { dir.appendingPathComponent($0) })
    }
}

func modeLabel(_ mode: CaptureMode) -> String {
    switch mode {
    case .call: "Call"
    case .inPerson: "In person"
    case .systemOnly: "System audio only"
    case .imported: "Imported"
    }
}

struct PlaybackBar: View {
    @Bindable var playback: PlaybackController
    @State private var scrub: Double?

    var body: some View {
        HStack {
            Button { playback.toggle() } label: {
                Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill").frame(width: 16)
            }
            .buttonStyle(.borderless)
            .keyboardShortcut(.space, modifiers: [])
            Text(Format.timestamp(playback.currentTime)).monospacedDigit()
            // Seeks only when the user releases the thumb; per-tick binding writes would keep rewinding playback.
            Slider(value: Binding(get: { scrub ?? playback.currentTime }, set: { scrub = $0 }), in: 0...max(playback.duration, 0.1)) { editing in
                if !editing, let time = scrub {
                    playback.seek(to: time)
                    scrub = nil
                }
            }
            Text(Format.timestamp(playback.duration)).monospacedDigit()
        }
        .font(.callout)
    }
}

struct LiveCaptionsView: View {
    let segments: [LiveSegment]

    var body: some View {
        ScrollViewReader { proxy in
            List(Array(segments.enumerated()), id: \.offset) { i, s in
                HStack(alignment: .firstTextBaseline) {
                    Text(Format.timestamp(s.start)).monospacedDigit().foregroundStyle(.secondary)
                    Text(s.speakerLabel).bold()
                    Text(s.text)
                }
                .id(i)
            }
            .overlay {
                if segments.isEmpty {
                    ContentUnavailableView("Listening…", systemImage: "waveform", description: Text("Live captions appear here."))
                }
            }
            .onChange(of: segments.count) { proxy.scrollTo(segments.count - 1, anchor: .bottom) }
        }
    }
}
