// swift-tools-version: 5.12
import PackageDescription

let package = Package(
    name: "LocalLabMlxIOS",
    platforms: [.iOS(.v17)],
    products: [.library(name: "LocalLabMlxIOS", targets: ["LocalLabMlxIOS"])],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "2.30.6")
    ],
    targets: [
        .target(
            name: "LocalLabMlxIOS",
            dependencies: [
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "MLXLLM", package: "mlx-swift-lm")
            ]
        ),
        .testTarget(name: "LocalLabMlxIOSTests", dependencies: ["LocalLabMlxIOS"])
    ]
)
