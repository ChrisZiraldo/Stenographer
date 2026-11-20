import StenoModel
import StenoStore
import SwiftUI

struct LibraryView: View {
    @Bindable var model: AppModel
    @State private var search = ""
    @State private var pendingDelete: SessionRecord?
    @State private var pendingReprocess: SessionRecord?
    @State private var mode = SidebarMode.meetings
    @State private var people: [SpeakerSummary] = []
    @State private var personID: String?

    enum SidebarMode: String, CaseIterable { case meetings = "Meetings", people = "People" }

    private func reloadPeople() {
        people = (try? SpeakerLibrary(model.database).summaries()) ?? []
    }

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                Picker("", selection: $mode) {
                    ForEach(SidebarMode.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding([.horizontal, .top], 8)
                switch mode {
                case .meetings: sidebar
                case .people:
                    PeopleList(
                        people: people.filter { search.isEmpty || $0.known.name.localizedCaseInsensitiveContains(search) },
                        selection: $personID)
                }
            }
            .navigationSplitViewColumnWidth(min: 240, ideal: 280)
        } detail: {
            switch mode {
            case .meetings:
                if let session = model.session(id: model.selection) {
                    SessionDetailView(model: model, session: session)
                        .id(session.id)
                } else {
                    ContentUnavailableView("No Session Selected", systemImage: "waveform", description: Text("Record or import audio to begin."))
                }
            case .people:
                if let person = people.first(where: { $0.id == personID }) {
                    PersonDetailView(
                        model: model, person: person, onChange: reloadPeople,
                        onOpen: { id in
                            model.selection = id
                            mode = .meetings
                        }
                    )
                    .id(person.id)
                } else {
                    ContentUnavailableView("No Person Selected", systemImage: "person.crop.rectangle.stack", description: Text("Choose someone to see every meeting you've had with them."))
                }
            }
        }
        .task { reloadPeople() }
        .onChange(of: mode) { reloadPeople() }
        .onChange(of: model.sessions) { reloadPeople() }
        .searchable(
            text: $search, placement: .sidebar,
            prompt: mode == .meetings ? "Search titles, notes, transcripts" : "Search people")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                RecordButton(model: model)
                SettingsLink { Label("Settings", systemImage: "gearshape") }
                    .help("Settings")
            }
        }
        .safeAreaInset(edge: .top) { StatusBanners(model: model) }
        .sheet(isPresented: $model.showOnboarding) { OnboardingView(model: model) }
        .alert("Stenographer", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
            Button("OK") { model.alert = nil }
        } message: {
            Text(model.alert ?? "")
        }
        .confirmationDialog(
            "Delete this session?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
        ) {
            Button("Move to Trash", role: .destructive) {
                if let s = pendingDelete { model.delete(s) }
            }
        } message: {
            Text("Its audio and transcript move to the Trash.")
        }
        .confirmationDialog(
            "Reprocess this session?",
            isPresented: Binding(get: { pendingReprocess != nil }, set: { if !$0 { pendingReprocess = nil } })
        ) {
            Button("Reprocess") {
                if let s = pendingReprocess { Task { await model.reprocess(s) } }
            }
        } message: {
            Text("Reprocessing replaces speaker names you edited.")
        }
    }

    private var sidebar: some View {
        let matches = model.search(search)
        let visible = model.sessions.filter { matches?.contains($0.id) ?? true }
        return List(selection: $model.selection) {
            ForEach(DateGroup.group(visible), id: \.title) { group in
                Section(group.title) {
                    ForEach(group.sessions) { session in
                        SessionRow(session: session, progress: model.processing?.sessionID == session.id ? model.processing?.fraction : nil)
                            .tag(session.id)
                            .contextMenu {
                                Button(session.starred ? "Unstar" : "Star") { model.setStarred(session, !session.starred) }
                                Button("Reprocess") { pendingReprocess = session }
                                    .disabled(session.status != .ready && session.status != .failed)
                                Divider()
                                Button("Delete…", role: .destructive) { pendingDelete = session }
                                    .disabled(session.status == .recording)
                            }
                    }
                }
            }
        }
    }
}

struct DateGroup {
    var title: String
    var sessions: [SessionRecord]

    static func group(_ sessions: [SessionRecord], now: Date = Date()) -> [DateGroup] {
        let calendar = Calendar.current
        let weekAgo = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: now))!
        let titles = ["Today", "Yesterday", "Previous 7 Days", "Earlier"]
        var buckets: [String: [SessionRecord]] = [:]
        for s in sessions {
            let title =
                calendar.isDateInToday(s.createdAt) ? titles[0]
                : calendar.isDateInYesterday(s.createdAt) ? titles[1] : s.createdAt >= weekAgo ? titles[2] : titles[3]
            buckets[title, default: []].append(s)
        }
        return titles.compactMap { t in buckets[t].map { DateGroup(title: t, sessions: $0) } }
    }
}

extension SessionRecord {
    var displayTitle: String {
        title.isEmpty ? "Untitled — \(createdAt.formatted(date: .abbreviated, time: .shortened))" : title
    }
}

struct SessionRow: View {
    let session: SessionRecord
    let progress: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(session.displayTitle).lineLimit(1)
                if session.starred { Image(systemName: "star.fill").foregroundStyle(.yellow).imageScale(.small) }
            }
            HStack(spacing: 6) {
                Text(Format.duration(session.durationSec)).monospacedDigit()
                StatusBadge(status: session.status, progress: progress)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

struct StatusBadge: View {
    let status: SessionStatus
    let progress: Double?

    var body: some View {
        switch status {
        case .recording: Label("Recording", systemImage: "record.circle").foregroundStyle(.red)
        case .captured: Text("Queued")
        case .processing:
            Text(progress.map { "Processing \(Int($0 * 100))%" } ?? "Processing")
        case .failed: Label("Failed", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
        case .ready: EmptyView()
        }
    }
}

struct RecordButton: View {
    let model: AppModel

    var body: some View {
        if model.recorder.isRecording {
            Button { Task { await model.recorder.stop() } } label: { Label("Stop", systemImage: "stop.circle.fill") }
                .tint(.red)
        } else {
            Button { Task { await model.recorder.start() } } label: { Label("Record", systemImage: "record.circle") }
        }
    }
}

struct StatusBanners: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            switch model.modelStatus {
            case .preparing:
                banner("Preparing speech models (first run downloads ~1 GB)…", systemImage: "arrow.down.circle")
            case .failed(let message):
                banner("Speech models unavailable: \(message)", systemImage: "exclamationmark.triangle") {
                    Button("Retry") { Task { await model.prepareModels() } }
                }
            case .ready:
                EmptyView()
            }
            if model.recorder.systemAudioSilent {
                banner("No system audio detected. Check Screen & System Audio Recording permission.", systemImage: "speaker.slash") {
                    Button("Open Settings") { NSWorkspace.shared.open(SystemAudioCheck.settingsURL) }
                    Button("Dismiss") { model.recorder.systemAudioSilent = false }
                }
            }
            if let text = model.banner {
                banner(text, systemImage: "info.circle") { Button("Dismiss") { model.banner = nil } }
            }
        }
    }

    private func banner(_ text: String, systemImage: String, @ViewBuilder actions: () -> some View = { EmptyView() }) -> some View {
        HStack {
            Label(text, systemImage: systemImage)
            Spacer()
            actions()
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
    }
}
