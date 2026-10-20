# T179 — iPhone 17 Pro Max group-chat and Liquid device proof

Pinned build for rows 2/4-6: EAS build `63b3ba76-566f-4bd6-905b-67b746a6cb2d` — app `0.1.0`
build `24`, `preview` (internal ad hoc) profile, source commit `8951af8` (clean tree; T178
chain head `feecd21` + buildNumber bump `5a910e7` + signing-scope fix), fingerprint
`dd1acc1d3a2b5c8832b2adf1c4beb62bc12d846c`, IPA 26,889,815 bytes
([record](../../../../builds/ios-preview-24.md)).
Row 3 additionally ships build 25 (in-app benchmark button; EAS `1edf8d93-ba68-4ac0-8ddc-14baa56d1216`,
source commit `e74c177`, IPA 26,905,332 bytes, sha256 `79ae17eb2787cc4624d4be7c71e54a6e43938af751c84725dbac4042d5f1cd9b`,
[record](../../../../builds/ios-preview-25.md)); row-3 manifests should come from it.
Install links: https://expo.dev/accounts/barrett/projects/locallab/builds/63b3ba76-566f-4bd6-905b-67b746a6cb2d (24)
and https://expo.dev/accounts/barrett/projects/locallab/builds/1edf8d93-ba68-4ac0-8ddc-14baa56d1216 (25).

Expected archive digest (downloaded 2026-10-20 from the artifact URL above, 26,889,815
bytes): SHA-256 `06b37aec9b2a6acab2ceb16d7c5fda84a8ca7979d0fb4c5c8c03ee30b057baa7` —
any on-phone install path (Expo link or manual IPA) installs this exact archive.

Known build caveat: preview build 24 has NO Extended Virtual Addressing / Increased Memory
Limit (the ad hoc profile predates those capabilities); benchmark rows must record memory
observations against the stock per-app budget.

Manifest format per row (one block per action):

```
row: <feature id + scenario>
device: iPhone 17 Pro Max (UDID 00008150-001844EC3C02401C)
build: 24 (63b3ba76-566f-4bd6-905b-67b746a6cb2d); row 3: 25 (1edf8d93-ba68-4ac0-8ddc-14baa56d1216)
os: <iOS version at run time>
model: <qwen/qwen3.5-4b-q4_k_m | liquid/lfm2.5-2.6b-q4_k_m | n/a>
action: <exact steps taken on device>
observed: <what the device actually did/printed/measured>
live: yes — run on physical device by <name> at <timestamp>
```

Fixture/web results are never device proof.

## Row status

| # | Card row | Status |
| - | -------- | ------ |
| 1 | Pinned build shipped, build id recorded | done (this directory + build record; commit `8951af8`) |
| 2 | Both GGUF downloads on device, `assertModelIntegrity` + GGUF magic pass | pending device run |
| 3 | Benchmark matrix offline/airplane: 2 models x {2,3,5}-persona rooms x {round-robin, dice, topic-interest}; latency, round duration, peak memory, thermal, personality consistency, repetition | pending device run — on build 25 press Settings → Developer benchmark → tick both models → Run matrix; the runner emits the manifest JSON (share sheet + Copy button, file under `Documents/locallab/bench/`); `build:` line use 25. Peak RSS still not observable in-app; the manifest records thermal + free bytes instead |
| 4 | Lifecycle: background mid-round release; foreground reopen no auto-resume; Stop mid-round; model switch mid-session; memory pressure | pending device run |
| 5 | Liquid: load, template sanity, top_k/penalty_repeat A/B, structured topic-interest selection parse, incompatibility error path (never substitutes Qwen) | pending device run |
| 6 | Avatars: pick/replace/remove in-app, list rows, history retention across replacement | pending device run |

## Default-model decision (card evidence bullet 2)

DEFERRED, standing decision unchanged: Qwen remains the on-device default. Liquid replaces
it ONLY if the row-3 device parity shows equal quality AND better speed in-app on the pinned
device builds (row 3 on build 25);
record the outcome here with its live manifests. Catalog wording already marks Liquid
"selectable, not the default" (`packages/models/catalog/src/index.ts:134`).
