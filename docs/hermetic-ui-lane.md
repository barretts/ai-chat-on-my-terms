# Hermetic UI lane

Deterministic local loop for exercising the mobile app's shipped screens
against fake model traffic, without devices or real providers. It backs the
T179 verification evidence (`docs/evidence/`) and the specs in `tests/ui/`.

## Pieces

- **Fake model server** — `tools/fake-model-server.mjs`
  (`pnpm fake-model:start`, port 8899). OpenAI-compatible: streamed +
  non-streamed chat completions and the group topic-selector JSON call. When
  the group driver's seat note (`Your name in this room is "NAME"`) appears
  in the prompt it parrots `Name: Fake beat N for Name.` so the
  `stripSpeakerPrefix` fix path is exercised. Tests: `pnpm test:fake-model`.
- **Metro web bundle** — `cd apps/mobile && pnpm exec expo start --web
  --port 8081` (or let `pnpm test:mobile-ui` boot its own `--no-dev`
  server; `reuseExistingServer` picks up a running one).
- **Specs** — `tests/ui/personas-starter-avatars.spec.ts`,
  `tests/ui/group-setup-spacing.spec.ts` (plus the pre-existing suites).
  Both intercept traffic (`page.route("**/*")`) and assert computed layout
  numbers, not pixels.
- **Avatar goldens** — `pnpm test:avatar-goldens` pins the 19 bundled busts
  (dimensions + sha256) and keeps the goldens, the asset map
  (`apps/mobile/platform/starter-avatars.assets.ts`), and the on-disk files
  in lockstep.
- **Evidence** — `docs/evidence/*.png` screenshots from the live loop, kept
  as human-facing artifacts; the specs carry the durable assertions.

## Web-specific platform facts

- Starter avatars import through `platform/starter-avatars.web.ts` (fetch the
  bundled asset into a blob, then the shared blob-store port). Plain
  `expo-file-system` `new File(uri).size` is stubbed on web — that's why the
  `.web.ts` variant exists; native keeps the require()-based attacher. Both
  read the same `AVATAR_ASSETS` map, so the two paths cannot drift.
- **Metro does not watch `packages/**` here** (no `watchFolders`). After
  editing any workspace package or adding a platform `.web.ts` file, kill and
  relaunch the server, then reload the page (first bundle 60–120 s). Freshness
  probe for the avatar shim:

  ```sh
  curl -s "http://127.0.0.1:8081/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=app&unstable_transformProfile=hermes-stable" | grep -c revokeObjectURL
  ```

- Panel shortcuts for manual driving: `/chat?panel=connections`,
  `/chat?panel=personas`, `/chat?panel=groups`.
- For `http://` provider endpoints the app blocks the fetch until
  "Authorize local HTTP origin" is toggled on in the connection editor.
- `accessibilityRole="summary"` renders as `<section role="region">` on web;
  computed-style assertions must query that element, not assume a `div`.

## Group chat on web (product boundary)

Group rooms bind a shared model only to **installed GGUFs**
(`composition/chat/group-chat-route.tsx`, `LOCAL_GGUF_PROVIDER_ID`), and
`platform/local-chat-provider.web.ts` deliberately refuses inference in
browsers ("Local GGUF inference is unavailable in this browser. Use the
iPhone app or configure a model server."). So on web the room screen shows
the explicit gate — `group-setup-spacing.spec.ts` pins that behavior (save a
room, assert the alert), while streamed group continuity stays covered by the
group unit suites (`pnpm test:group-features`) and the device checklist.
Extending rooms to network providers is a product decision, not lane plumbing.

## Spec idioms

- Reuse the `page.route("**/*")` pattern from `persona-context.spec.ts`:
  continue `data:`/`blob:`/app-origin/machine-seeded-probe traffic, abort the
  rest, fulfill the fixture origin (CORS on OPTIONS, `/models`, SSE body for
  `chat/completions`).
- Hidden mount-but-closed panels keep their DOM: scope text assertions (e.g.
  the room gate belongs to `getByRole("alert")`, since a hidden dropdown
  option carries similar text).
- RN-web windowed sheets scroll the window, not the ScrollView, so rows can
  land under the surface and hit-testing fails; `dispatchEvent("click")` on
  the resolved locator is the escape hatch (see the group spec).
