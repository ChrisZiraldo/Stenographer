import Darwin

public enum HostTime {
    public static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    public static func now() -> UInt64 { mach_absolute_time() }

    public static func seconds(fromHostTicks ticks: UInt64) -> Double {
        Double(ticks) * Double(timebase.numer) / Double(timebase.denom) / 1_000_000_000
    }

    /// Samples on the 16 kHz session timeline between two host times, rounded to nearest.
    /// Negative when `t` precedes `t0`.
    public static func samples16k(from t0: UInt64, to t: UInt64) -> Int64 {
        let seconds = t >= t0 ? seconds(fromHostTicks: t - t0) : -seconds(fromHostTicks: t0 - t)
        return Int64((seconds * 16_000).rounded())
    }

    public static func ticks(fromSeconds seconds: Double) -> UInt64 {
        UInt64((seconds * 1_000_000_000 * Double(timebase.denom) / Double(timebase.numer)).rounded())
    }
}
