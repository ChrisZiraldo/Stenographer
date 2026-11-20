import AppKit
import CoreAudio
import Foundation

/// Watches device and power changes; delivers debounced events on `queue`.
final class DeviceMonitor {
    enum Event { case deviceChanged, sleep, wake }

    private let queue: DispatchQueue
    private let handler: (Event) -> Void
    private var listeners: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    private var observers: [NSObjectProtocol] = []
    private var pending: DispatchWorkItem?

    init(queue: DispatchQueue, handler: @escaping (Event) -> Void) {
        self.queue = queue
        self.handler = handler
        let center = NSWorkspace.shared.notificationCenter
        observers.append(
            center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { [weak self] _ in
                // Synchronous: the system may sleep as soon as this returns.
                queue.sync { self?.fire(.sleep) }
            })
        observers.append(
            center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { [weak self] _ in
                queue.async { self?.debounce(.wake) }
            })
    }

    deinit {
        unwatchDevices()
        observers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
    }

    func watchDevices(clockDevice: AudioObjectID, aggregate: AudioObjectID, followDefaultInput: Bool, followDefaultOutput: Bool) {
        unwatchDevices()
        let system = AudioObjectID(kAudioObjectSystemObject)
        add(clockDevice, kAudioDevicePropertyDeviceIsAlive)
        add(aggregate, kAudioDevicePropertyNominalSampleRate)
        if followDefaultInput { add(system, kAudioHardwarePropertyDefaultInputDevice) }
        if followDefaultOutput { add(system, kAudioHardwarePropertyDefaultOutputDevice) }
    }

    func unwatchDevices() {
        for (object, address, block) in listeners {
            var addr = address
            AudioObjectRemovePropertyListenerBlock(object, &addr, queue, block)
        }
        listeners.removeAll()
        pending?.cancel()
        pending = nil
    }

    private func add(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) {
        var addr = CAProperty.address(selector)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.debounce(.deviceChanged) }
        if AudioObjectAddPropertyListenerBlock(object, &addr, queue, block) == noErr {
            listeners.append((object, addr, block))
        }
    }

    private func debounce(_ event: Event) {
        pending?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.fire(event) }
        pending = item
        queue.asyncAfter(deadline: .now() + 0.5, execute: item)
    }

    private func fire(_ event: Event) {
        if event == .sleep {
            pending?.cancel()
            pending = nil
        }
        handler(event)
    }
}
