import Foundation

public enum StenoJSON {
    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        return e
    }

    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }

    /// Atomically replaces `url` with `data` (temp file in the same directory + `replaceItemAt`).
    public static func writeAtomically(_ data: Data, to url: URL) throws {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        try data.write(to: tmp)
        if fm.fileExists(atPath: url.path) {
            _ = try fm.replaceItemAt(url, withItemAt: tmp)
        } else {
            try fm.moveItem(at: tmp, to: url)
        }
    }

    public static func write<T: Encodable>(_ value: T, to url: URL) throws {
        try writeAtomically(encoder().encode(value), to: url)
    }

    public static func read<T: Decodable>(_ type: T.Type, from url: URL) throws -> T {
        try decoder().decode(type, from: Data(contentsOf: url))
    }
}

public enum ManifestIO {
    public static let fileName = "manifest.json"

    public static func url(in sessionDir: URL) -> URL {
        sessionDir.appendingPathComponent(fileName)
    }

    public static func write(_ manifest: SessionManifest, to url: URL) throws {
        try StenoJSON.write(manifest, to: url)
    }

    public static func read(from url: URL) throws -> SessionManifest {
        try StenoJSON.read(SessionManifest.self, from: url)
    }
}
