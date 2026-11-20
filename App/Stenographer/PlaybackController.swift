import AVFoundation
import Foundation
import Observation

@Observable @MainActor
final class PlaybackController {
    private(set) var duration: TimeInterval = 0
    var currentTime: TimeInterval = 0
    private(set) var isPlaying = false
    private(set) var url: URL?
    private var player: AVAudioPlayer?
    private var timer: Timer?

    func load(_ url: URL?) {
        guard url != self.url else { return }
        stop()
        self.url = url
        player = url.flatMap { try? AVAudioPlayer(contentsOf: $0) }
        player?.prepareToPlay()
        duration = player?.duration ?? 0
        currentTime = 0
    }

    var isAvailable: Bool { player != nil }

    func toggle() {
        guard let player else { return }
        if player.isPlaying {
            player.pause()
            isPlaying = false
            timer?.invalidate()
        } else {
            player.play()
            isPlaying = true
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        }
    }

    func seek(to time: TimeInterval) {
        guard let player else { return }
        player.currentTime = max(0, min(time, duration))
        currentTime = player.currentTime
    }

    func stop() {
        player?.stop()
        timer?.invalidate()
        timer = nil
        isPlaying = false
    }

    private func tick() {
        guard let player else { return }
        currentTime = player.currentTime
        if !player.isPlaying {
            isPlaying = false
            timer?.invalidate()
        }
    }
}
