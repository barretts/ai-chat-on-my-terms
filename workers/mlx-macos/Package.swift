// swift-tools-version: 5.12
import PackageDescription

let package = Package(
    name: "LocalLabMlxMacWorker",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "locallab-mlx-worker", targets: ["LocalLabMlxWorker"]),
               .library(name: "LocalLabMlxMac", targets: ["LocalLabMlxMac"])],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "2.30.6")
    ],
    targets: [
        .target(name: "LocalLabMlxMac", dependencies: [
            .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
            .product(name: "MLXLLM", package: "mlx-swift-lm")
        ]),
        .executableTarget(name: "LocalLabMlxWorker", dependencies: ["LocalLabMlxMac"]),
        .testTarget(name: "LocalLabMlxMacTests", dependencies: ["LocalLabMlxMac"])
    ]
)
