# Pairing and relay v1 wire contract

The QR payload is a short-lived bootstrap object containing a random route ticket and a generated 256-bit pairing secret. The relay receives the route ticket hash only; it never receives the pairing secret. A peer hello proves secret possession and binds the protocol version, route, and roles into HKDF-SHA256 input. Fresh salts and nonces derive directional AES-256-GCM keys for each session. Counters are per direction, and receivers reject replayed or out-of-window counters.

The relay sees only opaque frames and routing metadata. It applies the one MiB frame limit, expiration, route allowlist, and byte limits. Binary transfers use bounded chunks and verify the declared length and SHA-256 after reassembly. The relay stores no message history. Sync payloads move only explicitly opted-in records and blobs; API keys, provider headers, pairing secrets, PINs, and model files are excluded.

Version 1 supports major version 1 and minor version 0. A peer with another major version or a higher unsupported minor version is rejected before encrypted application traffic starts. Minor 0 clients can communicate with earlier minor versions of the same major when every used content tag is supported.
