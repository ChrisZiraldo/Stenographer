import Foundation
import StenoModel

/// Names live caption segments from their voice embeddings. A voice close enough to a saved one gets its name;
/// any other voice joins the nearest unnamed live speaker or starts a new "Speaker N". Provisional: the final
/// transcript is relabelled by the offline pass.
public struct LiveSpeakerIdentifier: Sendable {
    private struct Cluster {
        var label: String
        var sum: [Float]
        var centroid: [Float]
    }

    /// Label for a voice that is too uncertain to name or to count as a new speaker.
    public static let uncertain = "Others"

    private let known: [KnownVoice]
    private var clusters: [Cluster] = []

    public init(known: [KnownVoice]) {
        self.known = known
    }

    public mutating func identify(_ embedding: [Float]) -> String {
        let unit = VoiceVector.normalized(embedding)
        let ranked = known.map { ($0.name, VoiceVector.cosineDistance(unit, $0.vector)) }.sorted { $0.1 < $1.1 }
        if let best = ranked.first, best.1 <= VoiceVector.matchThreshold,
            ranked.count < 2 || ranked[1].1 - best.1 >= VoiceVector.ambiguityMargin
        {
            return best.0
        }
        let nearest = clusters.indices.min {
            VoiceVector.cosineDistance(unit, clusters[$0].centroid) < VoiceVector.cosineDistance(unit, clusters[$1].centroid)
        }
        let clusterDistance = nearest.map { VoiceVector.cosineDistance(unit, clusters[$0].centroid) } ?? 2
        if let i = nearest, clusterDistance <= VoiceVector.matchThreshold {
            for k in unit.indices { clusters[i].sum[k] += unit[k] }
            clusters[i].centroid = VoiceVector.normalized(clusters[i].sum)
            return clusters[i].label
        }
        let closest = min(clusterDistance, ranked.first?.1 ?? 2)
        guard closest >= VoiceVector.newSpeakerDistance else { return Self.uncertain }
        let label = "Speaker \(clusters.count + 1)"
        clusters.append(Cluster(label: label, sum: unit, centroid: unit))
        return label
    }
}
