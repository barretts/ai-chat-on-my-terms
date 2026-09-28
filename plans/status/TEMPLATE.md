# Task status and evidence template

The coordinator alone edits status. Duplicate this template per card or keep an equivalent manifest. Implementation success and deep verification are separate fields.

- Task ID / phase / owner / branch / commit:
- State: queued | ready | running | review | implemented | blocked
- Dependency commits and contract/schema versions:
- Feature IDs × platform implemented (iPhone, iPad, Android, Mac, Windows, Linux):
- Owned changed paths:
- Quick contract/functional smoke command and result:
- Working build/device/model ID, if this is a milestone:
- Deferred deep-verification shard and per-platform evidence status:
- Real platform/backend/service evidence paths, if this is a deep card:
- External resource or credential still pending, with owner:
- Defects, reviewer and date:

Deep evidence files under docs/implementation/evidence/ include feature ID, platform, app/companion build, OS/device/backend/model version, action, observed result, live/fixture marker, evidence path and defect/applicability reason. Never include secrets or personal content. A fixture cannot mark a row verified.
