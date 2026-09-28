# Local semantic transcript search

`SQLiteSemanticSearch` indexes caller-supplied transcript snapshots. Each item carries conversation, message, and response-variant IDs, so a hit links to its exact source. The caller should pass the current transcript/variant snapshot after history mutations; each `reindex` removes source keys no longer present. `purgeConversation` removes a deleted conversation immediately.

Only an installed local `LocalEmbeddingRuntime` can be selected. Its model ID, artifact revision, and dimensions form the index identity. A new identity clears stored vectors before the next index build. Embedding work is split into bounded batches (16 by default; configurable up to 128). The current implementation stores vectors in SQLite and uses a cosine scan; it does not require a vector extension. When SQLite FTS5 is available it is maintained as a lexical fallback when embedding inference fails, and when FTS5 is unavailable the fallback returns no lexical hits.

The repository has no verified local embedding model artifact/runtime yet. Tests inject a deterministic two-dimensional fixture; this verifies indexing, source references, batch bounds, deletion, variant replacement, and identity rebuild behavior, but it is not real model inference. Offline-device inference and FTS5 behavior must be verified in the native SQLite build that ships with the app.
