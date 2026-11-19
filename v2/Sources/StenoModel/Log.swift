import os

public enum StenoLog {
    public static let subsystem = "com.ziraldo.Stenographer"
    public static let capture = Logger(subsystem: subsystem, category: "capture")
    public static let pipeline = Logger(subsystem: subsystem, category: "pipeline")
    public static let live = Logger(subsystem: subsystem, category: "live")
    public static let store = Logger(subsystem: subsystem, category: "store")
    public static let app = Logger(subsystem: subsystem, category: "app")
    public static let notes = Logger(subsystem: subsystem, category: "notes")
}
