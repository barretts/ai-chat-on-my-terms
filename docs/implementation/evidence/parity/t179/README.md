# T179 — iPhone 17 Pro Max group-chat and Liquid device proof

Pinned build for every row: EAS build `63b3ba76-566f-4bd6-905b-67b746a6cb2d` — app `0.1.0`
build `24`, `preview` (internal ad hoc) profile, source commit `8951af8` (clean tree; T178
chain head `feecd21` + buildNumber bump `5a910e7` + signing-scope fix), fingerprint
`dd1acc1d3a2b5c8832b2adf1c4beb62bc12d846c`, IPA 26,889,815 bytes
([record](../../../../builds/ios-preview-24.md)).
Install link: https://expo.dev/accounts/barrett/projects/locallab/builds/63b3ba76-566f-4bd6-905b-67b746a6cb2d

Known build caveat: preview build 24 has NO Extended Virtual Addressing / Increased Memory
Limit (the ad hoc profile predates those capabilities); benchmark rows must record memory
observations against the stock per-app budget.

Manifest format per row (one block per action):

```
row: <feature id + scenario>
device: iPhone 17 Pro Max (UDID 00008150-001844EC3C02401C)
build: 24 (63b3ba76-566f-4bd6-905b-67b746a6cb2d)
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
| 3 | Benchmark matrix offline/airplane: 2 models x {2,3,5}-persona rooms x {round-robin, dice, topic-interest}; latency, round duration, peak memory, thermal, personality consistency, repetition | pending device run |
| 4 | Lifecycle: background mid-round release; foreground reopen no auto-resume; Stop mid-round; model switch mid-session; memory pressure | pending device run |
| 5 | Liquid: load, template sanity, top_k/penalty_repeat A/B, structured topic-interest selection parse, incompatibility error path (never substitutes Qwen) | pending device run |
| 6 | Avatars: pick/replace/remove in-app, list rows, history retention across replacement | pending device run |

## Default-model decision (card evidence bullet 2)

DEFERRED, standing decision unchanged: Qwen remains the on-device default. Liquid replaces
it ONLY if the row-3 device parity shows equal quality AND better speed in-app on build 24;
record the outcome here with its live manifests. Catalog wording already marks Liquid
"selectable, not the default" (`packages/models/catalog/src/index.ts:134`).
