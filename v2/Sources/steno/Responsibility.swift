import Darwin
import Foundation

@_silgen_name("responsibility_spawnattrs_setdisclaim")
private func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

/// TCC attributes capture permission to the "responsible" process, normally the hosting terminal app,
/// which may lack `NSAudioCaptureUsageDescription` and gets refused without a prompt. Re-spawning with
/// responsibility disclaimed makes this binary (and its embedded Info.plist) the responsible process.
enum Responsibility {
    private static let marker = "STENO_RESPONSIBLE"

    /// Returns in the disclaimed child; the parent forwards SIGINT and exits with the child's status.
    static func becomeResponsibleProcess() {
        guard ProcessInfo.processInfo.environment[marker] != "1" else { return }
        guard let exe = Bundle.main.executablePath else { return }

        var attrs: posix_spawnattr_t?
        posix_spawnattr_init(&attrs)
        defer { posix_spawnattr_destroy(&attrs) }
        guard responsibility_spawnattrs_setdisclaim(&attrs, 1) == 0 else { return }

        let args = [exe] + CommandLine.arguments.dropFirst()
        let env = ProcessInfo.processInfo.environment.map { "\($0)=\($1)" } + ["\(marker)=1"]
        var cArgs = args.map { strdup($0) } + [nil]
        var cEnv = env.map { strdup($0) } + [nil]
        var pid: pid_t = 0
        let status = posix_spawn(&pid, exe, nil, &attrs, &cArgs, &cEnv)
        cArgs.forEach { free($0) }
        cEnv.forEach { free($0) }
        guard status == 0 else { return }

        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        let forward = [SIGINT, SIGTERM].map { sig in
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            source.setEventHandler { kill(pid, sig) }
            source.resume()
            return source
        }
        var childStatus: Int32 = 0
        while waitpid(pid, &childStatus, 0) < 0 && errno == EINTR {}
        withExtendedLifetime(forward) {}
        let exited = childStatus & 0x7f == 0
        exit(exited ? (childStatus >> 8) & 0xff : 128 + (childStatus & 0x7f))
    }
}
