# T179 — iPhone 17 Pro Max group-chat and Liquid device proof

Pinned build for rows 2/4-6: EAS build `63b3ba76-566f-4bd6-905b-67b746a6cb2d` — app `0.1.0`
build `24`, `preview` (internal ad hoc) profile, source commit `8951af8` (clean tree; T178
chain head `feecd21` + buildNumber bump `5a910e7` + signing-scope fix), fingerprint
`dd1acc1d3a2b5c8832b2adf1c4beb62bc12d846c`, IPA 26,889,815 bytes
([record](../../../../builds/ios-preview-24.md)).
Row 3 additionally ships build 25 (in-app benchmark button; EAS `1edf8d93-ba68-4ac0-8ddc-14baa56d1216`,
source commit `e74c177`, IPA 26,905,332 bytes, sha256 `79ae17eb2787cc4624d4be7c71e54a6e43938af751c84725dbac4042d5f1cd9b`,
[record](../../../../builds/ios-preview-25.md)), superseded for row 3 by build 26 (T181 fixes: ungated
section, rerun self-heal for stale `dev-bench-*` allocation rows, per-round progress, per-scenario on-disk
checkpoint manifests; EAS `0dc28760-647b-43de-bd25-5f16cdd8853e`, source commit `f9cd94c`, IPA 26,910,612
bytes, sha256 `6a2d1174c57a4a6d959e8d1c6c6f55b3a58c4f9ed7a91072155cecb7c968c3c4`,
[record](../../../../builds/ios-preview-26.md)), superseded for row 3 by build 27 (manifests record
`modelNames`; EAS `65cead1f-56fc-48b8-aac2-2f7d0819bfdf`, source commit `7be7c38`, IPA 26,910,812 bytes,
sha256 `f683b9fde2a2049125f3718909f7f2a62fcef07b6ea572841e59c5e478add09f`,
[record](../../../../builds/ios-preview-27.md)); remaining row-3 manifests should come from build 27.
Install links: https://expo.dev/accounts/barrett/projects/locallab/builds/63b3ba76-566f-4bd6-905b-67b746a6cb2d (24),
https://expo.dev/accounts/barrett/projects/locallab/builds/1edf8d93-ba68-4ac0-8ddc-14baa56d1216 (25),
https://expo.dev/accounts/barrett/projects/locallab/builds/0dc28760-647b-43de-bd25-5f16cdd8853e (26)
and https://expo.dev/accounts/barrett/projects/locallab/builds/65cead1f-56fc-48b8-aac2-2f7d0819bfdf (27).

Expected archive digest (downloaded 2026-10-20 from the artifact URL above, 26,889,815
bytes): SHA-256 `06b37aec9b2a6acab2ceb16d7c5fda84a8ca7979d0fb4c5c8c03ee30b057baa7` —
any on-phone install path (Expo link or manual IPA) installs this exact archive.

Known build caveat: preview builds 24-27 have NO Extended Virtual Addressing / Increased Memory
Limit (the ad hoc profile predates those capabilities; `app.json` has declared them since `f9cd94c`
but the reused profile strips them); benchmark rows must record memory
observations against the stock per-app budget.

Manifest format per row (one block per action):

```
row: <feature id + scenario>
device: iPhone 17 Pro Max (UDID 00008150-001844EC3C02401C)
build: 24 (63b3ba76-566f-4bd6-905b-67b746a6cb2d); row 3: 27 (65cead1f-56fc-48b8-aac2-2f7d0819bfdf)
os: <iOS version at run time>
model: <display name recorded in the manifest `modelNames` (27+), or catalog id | n/a>
action: <exact steps taken on device>
observed: <what the device actually did/printed/measured>
live: yes — run on physical device by <name> at <timestamp>
```

Fixture/web results are never device proof.

## Build-26 runs (2026-10-20, owner) — SUPERSEDED: provenance incomplete, kept as leads

Not valid row-3 proof: the owner cannot confirm which models were ticked (the partial's model
`blob:01a15b4d-…-139c173a8b7f` predates their later model update and is no longer identifiable)
nor whether either run was offline/airplane. Owner asked to start fresh; authoritative row-3
evidence will be new build-27 runs (model names auto-recorded in the manifest; airplane mode
asserted by owner at run time). Files kept for history:

Manifests from the owner's iPhone, archived here:

- `group-bench-20261020T2157-partial.json` — model `blob:01a15b4d-d661-7466-bcf7-139c173a8b7f`.
  Checkpoint written after scenario 2 (2-seat dice): the run stopped at scenario 3 — the FIRST
  topic-interest scenario, i.e. the first `json_object` selector call for this model — same cut-off
  point as the build-25 crash at 2/18. Round stats before the stop: 2-seat round-robin median
  3.8 s/reply, 32 tok/s, 3/4 replies hit the 128-token cap; 2-seat dice median 3.1 s/reply,
  30 tok/s, 7.9 s and 6.4 s rounds. The checkpoint survived the stop and shared after restart.
- `group-bench-20261020T2222.json` — model `blob:01a15b64-bb8b-7cf7-8c43-726346747095`.
  Full 9-scenario grid, 2 rounds each, all runs `finishReason: stop` except one: the 5-seat
  topic-interest first selector emitted 512 tokens and hit `length` (truncated JSON — core's
  seating-order fallback absorbed it and the scenario completed). Median reply latency 2.1-5.7 s;
  median throughput 9.2-14.4 tok/s; round durations: 2-seat rr 6.0-7.8 s, 3-seat rr 7.5-7.9 s,
  5-seat rr 26.2-31.4 s; topic-interest rounds are selector-dominated: 16-21 s (2-seat),
  19-20 s (3-seat), 45.7-59.0 s (5-seat, incl. the 31 s truncated selector).

Manifest fields: `buildNumber 26`, iOS 26.6, `deviceMemoryBytes 6744162304` (= 55% of 12 GB
Device.totalMemory, the onboarding fit estimate). `thermal` is `unknown` in every scenario:
react-native 0.86.3 exposes no `ProcessThermalState`, so thermal is not observable from the app —
record the gap, do not read `unknown` as nominal.

Quality finding (repetition/persona consistency): both models parrot the preceding seat.
In the full run's 2-seat round-robin, the poet's reply is the pirate's reply verbatim with a
`Bench Pirate:` prefix, and round 2 has both seats repeating it with doubled prefixes; each
5-seat scenario contains 21 verbatim/near-verbatim reply pairs. Persona differentiation does not
survive multi-seat transcripts on either model (repetition row of the card: FAIL observed on device).

```
row: T179 row 3 — device benchmark runs (partial grid + full grid)
device: iPhone 17 Pro Max (UDID 00008150-001844EC3C02401C)
build: 26 (0dc28760-647b-43de-bd25-5f16cdd8853e)
os: iOS 26.6
model: blob:01a15b4d-…-139c173a8b7f and blob:01a15b64-…-726346747095 — display names pending owner confirmation
action: Settings → Developer benchmark → tick one model → Run matrix (rounds=2, limit=128); run 1 stopped/crashed at scenario 3 of 9; run 2 completed 9/9; both manifests shared from the section
observed: run 2 full-grid latencies/throughput as above; run 1 checkpoint preserved 2 scenarios; crash/cut-off at first json_object selector for the other model; persona echo/parroting on both models
live: yes — run on physical device by owner at 2026-10-20T21:57Z (partial) and 2026-10-20T22:28Z (full)
```

Still open for row 3: model display names; whether either run was airplane/offline; the
model-identity of the stopped run's full grid; iOS crash log (`.ips`) for the 21:57 stop.

## Row status

| # | Card row | Status |
| - | -------- | ------ |
| 1 | Pinned build shipped, build id recorded | done (this directory + build record; commit `8951af8`) |
| 2 | Both GGUF downloads on device, `assertModelIntegrity` + GGUF magic pass | pending device run |
| 3 | Benchmark matrix offline/airplane: 2 models x {2,3,5}-persona rooms x {round-robin, dice, topic-interest}; latency, round duration, peak memory, thermal, personality consistency, repetition | pending fresh device run on build 27 (model names auto-recorded in manifest; airplane mode asserted by owner at run time). Build-26 runs above are provenance-incomplete leads only. Thermal unobservable (no RN 0.86.3 API); peak RSS still not observable in-app |
| 4 | Lifecycle: background mid-round release; foreground reopen no auto-resume; Stop mid-round; model switch mid-session; memory pressure | pending device run |
| 5 | Liquid: load, template sanity, top_k/penalty_repeat A/B, structured topic-interest selection parse, incompatibility error path (never substitutes Qwen) | pending device run |
| 6 | Avatars: pick/replace/remove in-app, list rows, history retention across replacement | pending device run |

## Default-model decision (card evidence bullet 2)

DEFERRED, standing decision unchanged: Qwen remains the on-device default. Liquid replaces
it ONLY if the row-3 device parity shows equal quality AND better speed in-app on the pinned
device builds (row 3 on build 27);
record the outcome here with its live manifests. Catalog wording already marks Liquid
"selectable, not the default" (`packages/models/catalog/src/index.ts:134`).
