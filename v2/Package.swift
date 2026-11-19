// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Stenographer",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "StenoModel", targets: ["StenoModel"]),
        .library(name: "StenoAudio", targets: ["StenoAudio"]),
        .library(name: "StenoPipeline", targets: ["StenoPipeline"]),
        .library(name: "StenoStore", targets: ["StenoStore"]),
        .library(name: "StenoXPC", targets: ["StenoXPC"]),
        .library(name: "StenoNotes", targets: ["StenoNotes"]),
        .executable(name: "steno", targets: ["steno"]),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.18.3", traits: ["Diarizer"]),
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.12.0"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.8.2"),
    ],
    targets: [
        .target(name: "StenoModel"),
        .target(name: "StenoAudio", dependencies: ["StenoModel"]),
        .target(
            name: "StenoPipeline",
            dependencies: ["StenoModel", "StenoAudio", .product(name: "FluidAudio", package: "FluidAudio")]
        ),
        .target(
            name: "StenoStore",
            dependencies: ["StenoModel", "StenoAudio", .product(name: "GRDB", package: "GRDB.swift")]
        ),
        .target(name: "StenoXPC", dependencies: ["StenoModel"]),
        .target(name: "StenoNotes", dependencies: ["StenoModel", "StenoStore"]),
        .executableTarget(
            name: "steno",
            dependencies: [
                "StenoModel", "StenoAudio", "StenoPipeline", "StenoStore",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/steno/Info.plist",
                ])
            ]
        ),
        .testTarget(name: "StenoAudioTests", dependencies: ["StenoAudio", "StenoModel"]),
        .testTarget(name: "StenoPipelineTests", dependencies: ["StenoPipeline", "StenoAudio", "StenoModel"]),
        .testTarget(name: "StenoStoreTests", dependencies: ["StenoStore", "StenoAudio", "StenoModel"]),
        .testTarget(name: "StenoNotesTests", dependencies: ["StenoNotes", "StenoStore", "StenoModel"]),
    ],
    swiftLanguageModes: [.v6]
)
