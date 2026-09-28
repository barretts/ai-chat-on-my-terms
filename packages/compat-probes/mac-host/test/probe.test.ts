import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../../", import.meta.url);

test("Mac host probe targets the pinned static Tauri and Rust shells", async () => {
  const desktop = JSON.parse(
    await readFile(new URL("apps/desktop/package.json", root), "utf8"),
  );
  const tauri = JSON.parse(
    await readFile(
      new URL("apps/desktop/src-tauri/tauri.conf.json", root),
      "utf8",
    ),
  );
  const companion = await readFile(
    new URL("apps/companion/Cargo.toml", root),
    "utf8",
  );
  assert.equal(desktop.dependencies.next, "16.1.0");
  assert.equal(desktop.devDependencies["@tauri-apps/cli"], "2.0.0");
  assert.equal(tauri.build.frontendDist, "../out");
  assert.match(companion, /name = "locallab-companion"/);
});

test("probe records a named Mac build gate instead of claiming non-Mac proof", async () => {
  const source = await readFile(
    new URL("../src/probe.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /pending: macOS host required/);
  assert.match(source, /pending: T029 owns the pinned inference sidecar/);
});
