# iPhone GGUF native feasibility probe

This package pins `llama.rn` 0.12.4 and exposes one bounded load, token-stream,
and cancellation run. It is a React Native native module and needs an Expo
development build; Expo Go and an iOS simulator are not valid inference tests.
llama.rn 0.10+ requires React Native's New Architecture, downloads the matching
prebuilt iOS framework at install time, and its documented iOS Metal path has
device GPU compatibility requirements. See the [upstream installation and
iOS notes](https://github.com/mybigday/llama.rn#installation).

The host app must install this workspace package, add the `llama.rn` Expo config
plugin, rebuild the native development client, and stage a small licensed GGUF
in app storage. Pass its local `file://` URI and SHA-256 plus the exact build ID
to `runGgufProbe`. The function bounds context and batch sizes, requests Metal
offload, emits token callbacks, asks for cancellation 1.5 seconds after the
first token by default (with a 30-second hard timeout), and releases the native
context. It rejects remote model paths and returns `unsupported` unless the
host reports a physical iOS device with model and OS identity.

Example:

```ts
const result = await runGgufProbe({
  modelUri: localGgufUri,
  modelSha256: verifiedSha256,
  buildId: `${gitRevision}+${nativeBuildNumber}`,
  device: {
    isPhysicalDevice: Device.isDevice,
    model: Device.modelName ?? "unknown",
    osVersion: Device.osVersion ?? "unknown",
  },
  onToken: (token) => appendProbeOutput(token),
});
```

Import `Device` from `expo-device`. A `passed` result means `request.stop()`
resolved; `completed_without_cancel` means generation finished before the
cancellation path ran and does not satisfy cancellation evidence.

Save the returned JSON without prompt contents or model path. On the physical
iPhone, add the device model, iOS version, observed peak app memory, thermal
state before/after, and whether the run reached at least one token before
cancellation. Do not infer a supported/unsupported device result from host or
simulator tests. Device execution is pending until an actual iPhone is used.

The result records package version, build ID, model hash, load latency, first
token latency, elapsed generation time, token count, and cancellation request.
This probe does not substitute for repeated performance, thermal soak, memory
pressure, or reliability verification planned for later milestones.
