import StenoModel
import SwiftUI

struct MenuBarView: View {
    let model: AppModel
    @AppStorage(SettingsKey.captureMode) private var mode = CaptureMode.call.rawValue
    @Environment(\.openWindow) private var openWindow

    private var recorder: RecorderController { model.recorder }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                RecordButton(model: model)
                    .controlSize(.large)
                Spacer()
                if let active = recorder.active {
                    TimelineView(.periodic(from: active.startedAt, by: 1)) { context in
                        Text(Format.duration(context.date.timeIntervalSince(active.startedAt)))
                            .monospacedDigit()
                            .font(.title3)
                    }
                }
            }
            Picker("Mode", selection: $mode) {
                ForEach([CaptureMode.call, .inPerson, .systemOnly], id: \.self) { Text(modeLabel($0)).tag($0.rawValue) }
            }
            .disabled(recorder.isRecording)
            LevelMeter(label: "Mic", dbfs: recorder.levels.micDBFS)
            LevelMeter(label: "System", dbfs: recorder.levels.systemDBFS)
            if !recorder.liveSegments.isEmpty {
                Divider()
                ForEach(Array(recorder.liveSegments.suffix(3).enumerated()), id: \.offset) { _, s in
                    (Text(s.speakerLabel + ": ").bold() + Text(s.text))
                        .font(.callout)
                        .lineLimit(3)
                }
            }
            Divider()
            HStack {
                Button("Open Stenographer") {
                    openWindow(id: "main")
                    NSApp.activate()
                }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
        .padding()
        .frame(width: 320)
    }
}

struct LevelMeter: View {
    let label: String
    let dbfs: Float?

    var body: some View {
        HStack {
            Text(label).font(.caption).frame(width: 48, alignment: .leading)
            GeometryReader { geo in
                let level = CGFloat(max(0, min(1, ((dbfs ?? -60) + 60) / 60)))
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule().fill(level > 0.9 ? Color.red : Color.green).frame(width: geo.size.width * level)
                }
            }
            .frame(height: 6)
        }
        .opacity(dbfs == nil ? 0.4 : 1)
    }
}
