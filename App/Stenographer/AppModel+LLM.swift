import Foundation
import StenoNotes

extension AppModel {
    /// The configured notes provider. The built-in model runs in the XPC worker.
    func makeLLMProvider() throws -> any LLMProvider {
        try LLMSettings.makeProvider(modelsDirectory: paths.modelsDirectory) { [worker] path, system, prompt in
            worker.generate(modelPath: path, system: system, prompt: prompt)
        }
    }
}
