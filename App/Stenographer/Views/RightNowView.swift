import StenoModel
import StenoNotes
import SwiftUI

/// Running catch-up summary of the live meeting. Refreshes on the interval set in Settings → AI (default 30 s) while visible.
@MainActor @Observable
final class LiveSummaryController {
    private(set) var summary = ""
    private(set) var isUpdating = false
    private(set) var lastUpdated: Date?
    private(set) var error: String?
    private var lastCount = 0

    func reset() {
        summary = ""
        lastUpdated = nil
        error = nil
        lastCount = 0
    }

    func refresh(model: AppModel, force: Bool) async {
        let segments = model.recorder.liveSegments
        guard !isUpdating, !segments.isEmpty, force || segments.count != lastCount else { return }
        isUpdating = true
        error = nil
        defer { isUpdating = false }
        do {
            let provider = try model.makeLLMProvider()
            if let text = try await LiveSummarizer.summarize(segments: segments, provider: provider) {
                summary = text
                lastUpdated = Date()
            }
            lastCount = segments.count
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct RightNowView: View {
    let model: AppModel
    @State private var controller = LiveSummaryController()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Right now").font(.headline)
                Spacer()
                if controller.isUpdating { ProgressView().controlSize(.small) }
                if let updated = controller.lastUpdated {
                    Text("Updated \(updated, style: .relative) ago").font(.caption).foregroundStyle(.secondary)
                }
                Button("Refresh") { Task { await controller.refresh(model: model, force: true) } }
                    .disabled(controller.isUpdating || model.recorder.liveSegments.isEmpty)
            }
            if let error = controller.error {
                Text(error).foregroundStyle(.orange)
            }
            if controller.summary.isEmpty {
                ContentUnavailableView(
                    model.recorder.liveSegments.isEmpty ? "Listening…" : "Summarizing…", systemImage: "text.bubble",
                    description: Text("A running summary of the last few minutes appears here."))
            } else {
                let parsed = LiveSummary.parse(controller.summary)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(parsed.topic).font(.title2.weight(.semibold))
                        if !parsed.bullets.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("JUST SAID").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                ForEach(Array(parsed.bullets.enumerated()), id: \.offset) { _, bullet in
                                    Label(bullet, systemImage: "circle.fill").labelStyle(BulletLabelStyle())
                                }
                            }
                        }
                        if let question = parsed.openQuestion {
                            Label(question, systemImage: "questionmark.bubble")
                                .padding(10)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if !["apple", "local"].contains(UserDefaults.standard.string(forKey: LLMSettings.providerKey) ?? "") {
                Text("Live transcript text is sent to your configured AI endpoint to produce this summary.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding()
        // Fill the pane and pin to the top so the empty state doesn't make the parent center everything.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task {
            // Re-runs when the first captions arrive, then every interval while the tab is visible.
            await controller.refresh(model: model, force: false)
            while !Task.isCancelled {
                // Read each pass so a Settings change applies without reopening the tab; 0 = manual only.
                let setting = UserDefaults.standard.integer(forKey: LLMSettings.liveSummaryIntervalKey)
                let seconds = setting > 0 ? max(5, setting) : 0
                try? await Task.sleep(for: .seconds(seconds > 0 ? seconds : 5))
                if seconds > 0 { await controller.refresh(model: model, force: false) }
            }
        }
    }
}

private struct BulletLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("•").foregroundStyle(.secondary)
            configuration.title
        }
    }
}
