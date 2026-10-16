# Committed fix review through fe06620

## Hypothesis

The 18 fix commits in `64ac49b..fe06620` resolve their assigned blockers without leaving equivalent failures in their committed execution paths.

Scope: focused source review for blockers, app-killing bugs, severe data loss and security release blockers. `64ac49b` commits the previously reviewed implementation and review documents; this pass examines the 18 subsequent fix commits. Source was read with `git show fe06620:<path>` and `git diff 64ac49b..fe06620`, so concurrent working-tree edits are excluded. No product tests, builds or runtime reproductions were executed. The scenarios below are source-derived counterexamples, not reported execution results.

## Failure Coordinates

### CR001 — P1 — R007 still reuses AES-GCM key/nonce pairs for handshakes

- **Commit:** `2b0acd7`.
- **Coordinates at reviewed commit:** `packages/remote/client/src/index.ts:160`; `packages/remote/crypto/src/index.ts:151`, `:156`, `:355`.
- **Evidence:** Every new client builds `createHandshakePairing` from the same saved pairing secret and deterministic QR-derived salts. Its handshake keys and nonce keys have no per-connection entropy, and each new SealingChannel begins at sequence zero. The first hello now contains a fresh random `sessionSalt` but is encrypted using that repeated key/nonce pair. Moving data frames to fresh session keys does not make repeated GCM encryption of the handshake safe. A fresh receiver also accepts the old handshake under its reset replay state.
- **Owner/fix:** R007 protocol owner. Give handshake encryption a safe unique nonce/key construction and authenticated freshness; retain fresh data-session keys and cross-language interoperability. Do not treat possession-proof-only payloads as exempt from AEAD nonce rules.

### CR002 — P1 — R007 reconnect reads the new handshake using the previous data key

- **Commit:** `2b0acd7`.
- **Coordinates at reviewed commit:** `packages/remote/client/src/index.ts:160–163`, `:175–176`, `:211`.
- **Evidence:** `connect()` explicitly allows a closed handle to reconnect, but handshake channels, `mobileEphemeral`, `dataToCompanion` and `dataFromCompanion` belong to the outer client lifetime. A completed session leaves `dataFromCompanion` set. On a second connection, a legitimate handshake-channel pairing-ready is passed to that old data opener by `(dataFromCompanion ?? handshake.mobile.fromCompanion).open(...)`, fails authentication/nonce validation, and sets re-pair-required. The same session entropy is also retained instead of generated for each connection.
- **Owner/fix:** R007 client lifecycle owner. Initialize connection-local negotiation and channel state for every connection; retire old listeners/channels and ignore callbacks from abandoned sockets. Keep this coordinated with CR001.

### CR003 — P1 — R006 loses the acknowledged copy boundary on receiver restart

- **Commit:** `a1ba5ab`.
- **Coordinates at reviewed commit:** `packages/sync/core/composition/src/index.ts:105`, `:160`, `:296–297`, `:382–391`.
- **Evidence:** Incoming chunks enter the in-memory `copy.applied` map and are acknowledged before `finalizeCopy()` commits replacement. Once the source sees every acknowledgement, it persists its own initialSyncDone. If the target process restarts after acknowledging the complete snapshot but before finalization, the target loses the membership map. Its next runInitialSync throws "initial copy has not been delivered yet"; the source's runInitialSync returns immediately because it is already done. Even if ordinary row state survives, it cannot reconstruct authoritative membership from the lost map. A target-only row is therefore never reliably removed and initial copy cannot complete through the normal retry API.
- **Owner/fix:** R006 composition owner. Persist snapshot membership/completion state or introduce a durable target-commit acknowledgement and resumable re-request protocol. Do not retire the source copy until target recovery can finish it.

### CR004 — P1 — R006 replacement deletes unselected local Persona/private-memory rows

- **Commit:** `a1ba5ab`.
- **Coordinates at reviewed commit:** `packages/sync/core/merge/src/index.ts:196–208`; call at `packages/sync/core/composition/src/index.ts:390`.
- **Evidence:** `applyCover` tombstones every live row absent from the source membership when `allowedType(row.entityType)` is true. A MergeStore configured with `PERSONA_TIER_TYPES` therefore treats all Persona, memory and attachment rows as replacement-owned. However, the source membership excludes unselected Personas and global/private memory through `personaGate`. The deletion loop never consults that gate, so those intentionally excluded local records become tombstones. This violates the selective-sync boundary despite the new comment claiming out-of-tier rows are untouched.
- **Owner/fix:** R006/R016 selective-sync owners. Pass an explicit replacement ownership predicate/member domain into the cover operation and preserve locally excluded/private rows. Entity type schema availability alone is not permission to delete a row.

### CR005 — P1 — R008 lost-ack recovery is disabled in default callers

- **Commit:** `5160da2`.
- **Coordinates at reviewed commit:** `packages/sync/core/transport/src/index.ts:258`; option forwarding at `packages/sync/core/composition/src/index.ts:121`; `packages/remote/integration/src/index.ts` in `syncOneConversation`.
- **Evidence:** The new watchdog returns immediately when ackTimeoutMs is undefined, which remains the default. SyncEngine forwards it only when explicitly supplied, and syncOneConversation supplies no timeout. A send that succeeds while its acknowledgement is lost therefore leaves a pending batch indefinitely. Initial-sync delivery waits or syncOneConversation promises never settle, and no bounded failure is published. The new lost-ack tests explicitly opt into the timer; they do not cover the default path.
- **Owner/fix:** R008 transport/composition owner. Use a bounded production default or configure the watchdog at every production composition boundary. Preserve one active pump and cancellation/wake semantics.

## Reproduction

Proposed discriminating scenarios, not executed in this source-only review:

1. **CR001:** Construct two clients from exactly the same QR, open each connection and capture each first sealed hello. Compare sequence and advertised nonce under their deterministic handshake derivation; both begin at zero with the same key/nonce despite differing ephemeral plaintext.
2. **CR002:** Pair successfully using a single handle, disconnect it, call connect() again on that same handle, and deliver a valid handshake-key pairing-ready for the second connection. The old data opener is selected instead of the handshake opener.
3. **CR003:** Complete source delivery of a copy-phone snapshot to a Mac target, including all batch acknowledgements, but stop before target runInitialSync finalizes. Recreate the target engine with its persisted preferences and row state. Retry both peers: source is already done; target has no membership map and cannot finalize.
4. **CR004:** Seed a target MergeStore(PERSONA_TIER_TYPES) with an unselected Persona and a global-scoped memory. Perform a copy with valid incoming chat membership that excludes both. Finalize and inspect those local rows: applyCover changes their payloads to null.
5. **CR005:** Use normal SyncEngine or syncOneConversation options without ackTimeoutMs. Let send resolve and drop all acknowledgements. There is no armed retry/failure timer to advance or settle the operation.

## Verification

**VERDICT: FAIL — the committed fixes still contain the five source-established failure paths above.**

The following 15 fix assignments have no additional blocker established in this focused source pass: R001, R002, R003, R004, R009, R010, R015, R016, R017, R020, R021, R022, R023, R024, R027. This is not runtime acceptance; Swift/iOS/macOS, Docker, live pairing and configured service behavior were not executed. R006, R007 and R008 remain incomplete for the reasons above.

The earlier findings without a fix commit in the reviewed range are R005, R011, R012, R013, R014, R018, R019, R025, R026 and R028. Their earlier status is not cleared by this pass. R028 working-tree changes were present and deliberately excluded.

Only this review document was written by this review. Existing source modifications belong to the ongoing implementation work and were left intact. Review coordinates refer to fe06620 even if the branch advances later.
