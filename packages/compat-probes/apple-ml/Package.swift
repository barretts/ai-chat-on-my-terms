// swift-tools-version: 5.12
import PackageDescription

let package = Package(
    name: "LocalLabAppleMLProbe",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "AppleMLProbeCore", targets: ["AppleMLProbeCore"])],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "2.30.6"),
        .package(url: "https://github.com/apple/ml-stable-diffusion", exact: "1.1.1"),
    ],
    targets: [
        .target(
            name: "AppleMLProbeCore",
            dependencies: [
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "MLXLLM", package: "mlx-swift-lm"),
                .product(name: "StableDiffusion", package: "ml-stable-diffusion"),
            ],
            path: "Sources/AppleMLProbeCore"
        ),
        .testTarget(name: "AppleMLProbeCoreTests", dependencies: ["AppleMLProbeCore"]),
    ]
)
