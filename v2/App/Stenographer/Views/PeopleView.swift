import StenoModel
import StenoStore
import SwiftUI

/// Stable per-name color (String.hashValue is randomized per launch, so derive it from the scalars).
private func avatarColor(_ name: String) -> Color {
    let seed = name.lowercased().unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
    return TranscriptView.palette[Int(seed % UInt32(TranscriptView.palette.count))]
}

private func initials(_ name: String) -> String {
    let letters = name.split(separator: " ").prefix(2).compactMap(\.first)
    return letters.isEmpty ? "?" : String(letters).uppercased()
}

struct Avatar: View {
    let name: String
    var size: CGFloat = 40

    var body: some View {
        Text(initials(name))
            .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(avatarColor(name).gradient, in: Circle())
    }
}

private func summaryLine(_ person: SpeakerSummary) -> String {
    guard person.meetingCount > 0 else { return "No meetings yet" }
    var parts = ["\(person.meetingCount) meeting\(person.meetingCount == 1 ? "" : "s")"]
    if let last = person.lastMet { parts.append("last \(last.formatted(date: .abbreviated, time: .omitted))") }
    return parts.joined(separator: " · ")
}

struct PeopleList: View {
    let people: [SpeakerSummary]
    @Binding var selection: String?

    var body: some View {
        if people.isEmpty {
            ContentUnavailableView(
                "No People Yet", systemImage: "person.crop.rectangle.stack",
                description: Text("Rename a speaker in a transcript and keep \"Remember this voice\" on to add them here."))
        } else {
            List(people, selection: $selection) { person in
                HStack(spacing: 10) {
                    Avatar(name: person.known.name)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(person.known.name).font(.headline).lineLimit(1)
                        Text(summaryLine(person)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
                .tag(person.id)
            }
        }
    }
}

struct PersonDetailView: View {
    let model: AppModel
    let person: SpeakerSummary
    let onChange: () -> Void
    let onOpen: (String) -> Void
    @State private var name = ""
    @State private var meetings: [SpeakerMeeting] = []
    @State private var confirmForget = false

    private var library: SpeakerLibrary { SpeakerLibrary(model.database) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            card
                .padding()
            Divider()
            if meetings.isEmpty {
                ContentUnavailableView(
                    "No Meetings Yet", systemImage: "calendar",
                    description: Text("Meetings appear here once this voice is recognized in a transcript. Try Settings → Speakers → Recognize in Past Sessions."))
            } else {
                List(meetings) { meeting in
                    Button { onOpen(meeting.session.id) } label: { row(meeting) }
                        .buttonStyle(.plain)
                }
            }
        }
        .task(id: person) {
            name = person.known.name
            meetings = (try? library.meetings(of: person.id)) ?? []
        }
        .confirmationDialog("Forget \(person.known.name)'s voice?", isPresented: $confirmForget) {
            Button("Forget Voice", role: .destructive) { forget() }
        } message: {
            Text("Existing transcripts keep their names, but new meetings won't be labelled automatically.")
        }
    }

    private var card: some View {
        HStack(alignment: .top, spacing: 16) {
            Avatar(name: person.known.name, size: 72)
            VStack(alignment: .leading, spacing: 10) {
                TextField("Name", text: $name)
                    .textFieldStyle(.plain)
                    .font(.title.weight(.semibold))
                    .onSubmit(rename)
                HStack(spacing: 24) {
                    stat("Meetings", "\(person.meetingCount)")
                    stat("Spoke for", Format.duration(person.speakingSeconds))
                    stat("Last met", person.lastMet?.formatted(date: .abbreviated, time: .omitted) ?? "—")
                    stat("Voice samples", "\(person.known.sampleCount)")
                }
            }
            Spacer()
            Button("Forget Voice…", role: .destructive) { confirmForget = true }
        }
    }

    private func stat(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.headline).monospacedDigit()
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func row(_ meeting: SpeakerMeeting) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(meeting.session.displayTitle).lineLimit(1)
                Text(meeting.session.createdAt.formatted(date: .complete, time: .shortened))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.duration(meeting.session.durationSec)).monospacedDigit()
                Text("spoke \(Format.duration(meeting.speakingSeconds))").font(.caption).foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }

    private func rename() {
        do { try library.rename(id: person.id, to: name) } catch { model.alert = error.localizedDescription }
        onChange()
    }

    private func forget() {
        do { try library.delete(id: person.id) } catch { model.alert = error.localizedDescription }
        onChange()
    }
}
