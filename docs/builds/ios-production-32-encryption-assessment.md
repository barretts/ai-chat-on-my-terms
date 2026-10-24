# Build 32 encryption assessment

Assessed October 23, 2026 for the owner's explicit request to make build 32 available to the internal Owner TestFlight group.

## Artifact and result

This assessment applies to the signed **0.1.0 (32)** IPA, SHA-256 `f0e53f5ea72f40d57bd82d5e5bd372b7adbbd2ceb0d44aadb0311e7ac6937aa1`, source checkpoint `bb04869f1ae2f7478b2c5ecc6464ac0d2c5c1dfd` plus the build counter increment. Its embedded JavaScript SHA-256 is `da23ad96b18d42e9bf0c21e221cbfe11574fa64248ffa2c5ab446b6911cd5fdd`.

The reviewed iOS implementation uses encryption provided by Apple's operating system. The build-specific declaration is **`usesNonExemptEncryption: false`**, meaning no non-exempt encryption, not a claim that the app uses no encryption.

## Evidence

- Native networking uses the iOS networking stack for HTTPS. Secret storage uses Expo Secure Store's Security/Keychain calls (`SecItemAdd`, `SecItemCopyMatching`, `SecItemDelete`).
- `apps/mobile/platform/crypto.ts` obtains random bytes, UUIDs and SHA-256 through Expo Crypto. Expo Crypto 57.0.4's native implementation uses Apple CommonCrypto, Security and CryptoKit; its AES-GCM implementation calls `CryptoKit.AES.GCM` rather than bundling a separate cipher implementation.
- The root application mounts `<BackupProvider>` without a `cryptoPort`. The provider returns before creating a backup client when this port is absent. The backup package's AES-256-GCM and Argon2 envelope labels are present as format metadata; no native or JavaScript Argon2/key-derivation implementation is injected for this build.
- The repository's custom remote encryption engine is a Node implementation using `createCipheriv`, `createDecipheriv`, `hkdfSync` and the `aes-256-gcm` cipher name. Those symbols and the handshake entry point are absent from the signed build's embedded JavaScript. The mobile remote layer requires a separately injected native pairing engine; repository code for the desktop protocol alone does not establish a shipped iOS encryption implementation.
- Inspected the production Pod lockfile, embedded frameworks and executable dependencies. Expo Crypto and Apple-backed APIs are present; no separate OpenSSL, BoringSSL, CryptoSwift, TweetNaCl or Noble cipher dependency was identified in that inventory. Byte-string checks support the source/composition assessment; they are not its sole basis.

## Apple guidance and scope

Apple states that encryption built into the operating system, including HTTPS through URLSession, is typically exempt from export-documentation upload requirements. Its `ITSAppUsesNonExemptEncryption` documentation permits `false` for apps that use only exempt encryption, including linked libraries. See [Complying with Encryption Export Regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations) and [ITSAppUsesNonExemptEncryption](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption).

Apply this finding to build 32's App Store Connect metadata. The already signed IPA is unchanged. Reassess before enabling a native backup crypto port, shipping the custom relay engine, adding a cipher implementation, or applying this conclusion to a different artifact. This does not change privacy declarations or authorize App Review submission or public release.
