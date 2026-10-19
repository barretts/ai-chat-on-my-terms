import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const resultsDirectory = process.env.LOCALLAB_DESKTOP_SMOKE_RESULTS
  ? resolve(process.env.LOCALLAB_DESKTOP_SMOKE_RESULTS)
  : resolve(__dirname, "../../../tmp/desktop-smoke-results");

// The built desktop app is launched by the spec itself (WebView2 with a CDP
// port), so there is deliberately no webServer and no browser project: the
// test must not request the page/browser fixtures.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 300_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: resultsDirectory,
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(resultsDirectory, "report.json") }],
  ],
  use: {
    actionTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "desktop" }],
});
