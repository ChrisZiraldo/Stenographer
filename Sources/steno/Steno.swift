import ArgumentParser
import Foundation
import StenoModel
import StenoPipeline

@main
struct Steno: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "steno",
        abstract: "Stenographer audio core.",
        subcommands: [
            Transcribe.self, Diarize.self, Devices.self, Record.self, Recover.self, Finalize.self, Import.self,
            Process.self, Notes.self, LiveReplay.self,
        ]
    )
}

func printJSON<T: Encodable>(_ value: T) throws {
    let data = try StenoJSON.encoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func absoluteURL(_ path: String) -> URL {
    URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
}

struct Transcribe: AsyncParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Transcribe a WAV file with Parakeet v3.")

    @Argument var wav: String
    @Flag var json = false

    func run() async throws {
        let words = try await Transcriber().transcribe(file: absoluteURL(wav), track: .imported)
        if json {
            try printJSON(words)
        } else {
            print(words.map(\.text).joined(separator: " "))
        }
    }
}

struct Diarize: AsyncParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Diarize a WAV file with pyannote community-1.")

    @Argument var wav: String
    @Flag var json = false
    @Option var maxSpeakers: Int?

    func run() async throws {
        let output = try await Diarizer().diarize(file: absoluteURL(wav), maxSpeakers: maxSpeakers)
        if json {
            try printJSON(output.turns)
        } else {
            for turn in output.turns {
                print(String(format: "%@ %.2f–%.2f", turn.speaker, turn.start, turn.end))
            }
        }
    }
}
