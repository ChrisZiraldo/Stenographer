import Foundation
import StenoModel

public enum Recovery {
    /// Repairs a session left in `.recording` (crash, kill, power loss) and marks it captured.
    @discardableResult
    public static func repairSession(at dir: URL) throws -> SessionManifest {
        let manifestURL = ManifestIO.url(in: dir)
        var manifest = try ManifestIO.read(from: manifestURL)
        guard manifest.state == .recording else { return manifest }

        let fm = FileManager.default
        var latest = (try? fm.attributesOfItem(atPath: manifestURL.path)[.modificationDate] as? Date) ?? Date()
        var parts: [CapturePart] = []
        for var part in manifest.parts {
            let url = dir.appendingPathComponent(part.file)
            guard fm.fileExists(atPath: url.path) else { continue }
            if let mtime = try? fm.attributesOfItem(atPath: url.path)[.modificationDate] as? Date, mtime > latest {
                latest = mtime
            }
            part.sampleCount = try WAVWriter.repair(url)
            guard fm.fileExists(atPath: url.path) else { continue }
            if part.endReason == nil { part.endReason = .crash }
            parts.append(part)
        }
        manifest.parts = parts
        manifest.state = .captured
        manifest.endedAt = latest
        try ManifestIO.write(manifest, to: manifestURL)
        StenoLog.capture.info("Recovered session \(manifest.id, privacy: .public): \(parts.count) parts")
        return manifest
    }
}
