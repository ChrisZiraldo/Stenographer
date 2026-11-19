import StenoAudio
import StenoModel
import StenoNotes
import SwiftUI

struct SettingsView: View {
    let model: AppModel

    var body: some View {
        TabView {
            Tab("General", systemImage: "gearshape") { GeneralSettings() }
            Tab("AI", systemImage: "sparkles") { AISettings() }
            Tab("Storage", systemImage: "internaldrive") { StorageSettings(model: model) }
        }
        .frame(width: 460)
        .padding()
    }
}

struct GeneralSettings: View {
    @AppStorage(SettingsKey.captureMode) private var mode = CaptureMode.call.rawValue
    @AppStorage(SettingsKey.micDeviceUID) private var micUID = ""
    @AppStorage(SettingsKey.liveEnabled) private var liveEnabled = true
    @AppStorage(SettingsKey.maxSpeakers) private var maxSpeakers = 0
    @State private var devices = DeviceCatalog.inputDevices()

    var body: some View {
        Form {
            Picker("Recording mode", selection: $mode) {
                ForEach([CaptureMode.call, .inPerson, .systemOnly], id: \.self) { Text(modeLabel($0)).tag($0.rawValue) }
            }
            Picker("Microphone", selection: $micUID) {
                Text("System default").tag("")
                ForEach(devices) { Text($0.name).tag($0.uid) }
            }
            Toggle("Live captions while recording", isOn: $liveEnabled)
            Stepper(value: $maxSpeakers, in: 0...10) {
                Text(maxSpeakers == 0 ? "Maximum speakers: automatic" : "Maximum speakers: \(maxSpeakers)")
            }
        }
        .onAppear { devices = DeviceCatalog.inputDevices() }
    }
}

struct AISettings: View {
    @AppStorage(LLMSettings.providerKey) private var provider = "apple"
    @AppStorage(LLMSettings.baseURLKey) private var baseURL = LLMSettings.defaultBaseURL
    @AppStorage(LLMSettings.modelKey) private var modelName = ""
    @AppStorage(LLMSettings.maxPromptCharsKey) private var maxPromptChars = LLMSettings.defaultMaxPromptChars
    @State private var apiKey = Keychain.apiKey() ?? ""
    @State private var testOutput = ""
    @State private var testing = false

    var body: some View {
        Form {
            Picker("Provider", selection: $provider) {
                Text(AppleOnDeviceProvider.isAvailable ? "Apple Intelligence (on device)" : "Apple Intelligence (unavailable)").tag("apple")
                Text("OpenAI-compatible (Ollama, LM Studio, cloud)").tag("openai-compatible")
            }
            if provider == "openai-compatible" {
                TextField("Base URL", text: $baseURL)
                TextField("Model", text: $modelName, prompt: Text("e.g. llama3.2"))
                SecureField("API key", text: $apiKey, prompt: Text("optional"))
                    .onSubmit { Keychain.setAPIKey(apiKey) }
                    .onChange(of: apiKey) { Keychain.setAPIKey(apiKey) }
                TextField("Max prompt characters", value: $maxPromptChars, format: .number)
            }
            HStack {
                Button("Test") { test() }.disabled(testing)
                if testing { ProgressView().controlSize(.small) }
                Text(testOutput).lineLimit(3).foregroundStyle(.secondary)
            }
        }
    }

    private func test() {
        testing = true
        testOutput = ""
        Task {
            do {
                let p = try LLMSettings.makeProvider()
                for try await delta in p.stream(system: "You are a helpful assistant.", prompt: "Reply with OK") {
                    testOutput += delta
                }
            } catch {
                testOutput = "Failed: \(error.localizedDescription)"
            }
            testing = false
        }
    }
}

struct StorageSettings: View {
    let model: AppModel
    @State private var size: Int64?

    var body: some View {
        Form {
            LabeledContent("Data folder") {
                Text(model.paths.root.path).textSelection(.enabled).lineLimit(2)
            }
            LabeledContent("Total size") {
                Text(size.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "…")
            }
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([model.paths.root]) }
        }
        .task {
            let root = model.paths.root
            size = await Task.detached { AppModel.storageSize(root: root) }.value
        }
    }
}
