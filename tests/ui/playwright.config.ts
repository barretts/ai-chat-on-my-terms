import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const resultsDirectory = process.env.LOCALLAB_UI_RESULTS
  ? resolve(process.env.LOCALLAB_UI_RESULTS)
  : resolve(__dirname, "../../tmp/mobile-ui-results");
const previewUrl = process.env.LOCALLAB_UI_BASE_URL ?? "http://localhost:8081";
const previewPort = new URL(previewUrl).port || "8081";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: resultsDirectory,
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(resultsDirectory, "report.json") }],
  ],
  use: {
    baseURL: previewUrl,
    channel: "chrome",
    actionTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    {
      name: "phone",
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "chromium",
        channel: "chrome",
      },
    },
  ],
  webServer: {
    command: `powershell -NoProfile -File tools/run-pnpm.ps1 --filter @locallab/mobile exec expo start --localhost --port ${previewPort} --no-dev`,
    url: previewUrl,
    cwd: "../..",
    reuseExistingServer: true,
    timeout: 180_000,
    env: { CI: "true" },
  },
});
