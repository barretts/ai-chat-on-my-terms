#!/usr/bin/env node
// Desktop frontend bundle sync (contract: Packaging).
//
// Runs the Expo web static export of @locallab/mobile (`export:web`, outDir
// apps/mobile/dist/web) and copies the result into
// apps/desktop/dist/desktop-bundle — the `frontendDist` path in
// src-tauri/tauri.conf.json. Invoked by tauri's beforeDev/beforeBuild commands
// and standalone: `node scripts/build-bundle.mjs` (from apps/desktop).
// `--dev` skips the export when the bundle already exists (fast `tauri dev`).

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const mobileDist = join(repoRoot, "apps", "mobile", "dist");
const bundleDir = join(desktopRoot, "dist", "desktop-bundle");

const isDev = process.argv.includes("--dev");

function findExportDir() {
  // Preferred layout is dist/web (script pins --output-dir); accept the
  // per-platform subdirs or a bare dist root as fallbacks.
  const candidates = [
    join(mobileDist, "web"),
    join(mobileDist, "web-production"),
    mobileDist,
  ];
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}

if (isDev && existsSync(join(bundleDir, "index.html"))) {
  console.log("[build-bundle] desktop bundle present; skipping export (--dev)");
} else {
  console.log("[build-bundle] running pnpm --filter @locallab/mobile export:web");
  const result = spawnSync("pnpm", ["--filter", "@locallab/mobile", "export:web"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`[build-bundle] export:web failed (exit ${result.status ?? "signal"})`);
    process.exit(result.status ?? 1);
  }
}

const src = findExportDir();
if (!src) {
  console.error(
    `[build-bundle] no index.html under ${mobileDist} (checked dist/web, dist/web-production, dist)`,
  );
  process.exit(1);
}

rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
cpSync(src, bundleDir, { recursive: true });
console.log(`[build-bundle] ${src} -> ${bundleDir}`);
