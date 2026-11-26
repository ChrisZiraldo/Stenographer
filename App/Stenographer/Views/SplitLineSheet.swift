import StenoStore
import SwiftUI

/// Hands part of a transcript line to another speaker: click the first and last word to move, pick who said it.
struct SplitLineSheet: View {
    let line: TranscriptLine
    let speakers: [SpeakerRecord]
    /// Names from the People list, offered when naming a new speaker.
    let people: [String]
    /// Moves words `range` of the line to the existing speaker `speakerID`.
    let assignToExisting: (_ range: Range<Int>, _ speakerID: String) -> Void
    /// Moves words `range` of the line to a new speaker called `name`.
    let assignToNew: (_ range: Range<Int>, _ name: String) -> Void
    /// Deletes words `range` of the line.
    let remove: (_ range: Range<Int>) -> Void
    let cancel: () -> Void

    private static let newSpeaker = "new"
    private static let removeWords = "remove"

    @State private var first: Int?
    @State private var last: Int?
    @State private var choice = SplitLineSheet.newSpeaker
    @State private var newName = ""

    private var words: [String] { RunRepository.words(of: line.text) }

    private var selection: Range<Int>? {
        guard let first else { return nil }
        let other = last ?? first
        return min(first, other)..<(max(first, other) + 1)
    }

    private var canApply: Bool {
        guard selection != nil else { return false }
        if choice == Self.removeWords { return true }
        if choice == Self.newSpeaker { return !newName.trimmingCharacters(in: .whitespaces).isEmpty }
        return choice != line.speaker.id
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Reassign or remove part of this line").font(.headline)
            Text(
                "Click the first word, then the last word, that \(line.speaker.name) did not say. "
                    + "A third click starts over."
            )
            .foregroundStyle(.secondary)
            WordFlow(spacing: 4) {
                ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                    Text(word)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(selection?.contains(index) == true ? Color.accentColor.opacity(0.35) : .clear, in: RoundedRectangle(cornerRadius: 4))
                        .contentShape(Rectangle())
                        .onTapGesture { tap(index) }
                }
            }
            .padding(8)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
            Picker("Move to", selection: $choice) {
                ForEach(speakers.filter { $0.id != line.speaker.id }) { Text($0.name).tag($0.id) }
                Text("New speaker…").tag(Self.newSpeaker)
                Divider()
                Text("Remove these words (echo or duplicate)").tag(Self.removeWords)
            }
            if choice == Self.newSpeaker {
                HStack {
                    TextField("Name of the new speaker", text: $newName)
                    PeoplePickerMenu(names: people) { newName = $0 }
                }
            }
            HStack {
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
                Button(choice == Self.removeWords ? "Remove" : "Reassign", action: apply).keyboardShortcut(.defaultAction).disabled(!canApply)
            }
        }
        .padding()
        .frame(width: 460)
    }

    private func tap(_ index: Int) {
        if first == nil || last != nil {
            first = index
            last = nil
        } else {
            last = index
        }
    }

    private func apply() {
        guard let range = selection else { return }
        if choice == Self.removeWords {
            remove(range)
        } else if choice == Self.newSpeaker {
            assignToNew(range, newName)
        } else {
            assignToExisting(range, choice)
        }
    }
}

/// Lays out children left to right, wrapping to a new row when the width runs out.
private struct WordFlow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        layout(in: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, origin) in zip(subviews, layout(in: bounds.width, subviews: subviews).origins) {
            subview.place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }

    private func layout(in width: CGFloat, subviews: Subviews) -> (origins: [CGPoint], size: CGSize) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return (origins, CGSize(width: maxX, height: y + rowHeight))
    }
}
