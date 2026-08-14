// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TableauElectricite",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "TableauElectricite",
            path: "Sources/TableauElectricite"
        ),
        .executableTarget(
            name: "AppleSpeechCli",
            path: "Sources/AppleSpeechCli"
        )
    ]
)
