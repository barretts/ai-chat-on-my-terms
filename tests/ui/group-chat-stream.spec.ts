import { expect, test } from "@playwright/test";

/**
 * Hermetic group-streaming proof (dev harness lane): a room bound to the
 * dev-only "Dev harness" model (EXPO_PUBLIC_DEV_GROUP_HTTP pointing at
 * `tools/fake-model-server.mjs`) drives the real driver, lease, provider
 * adapter, SSE parsing, speaker-prefix strip, and transcript UI end to end.
 *
 * The harness is compiled out of store/`--no-dev` bundles and needs the env
 * var, so on servers without it the shared-model sheet has no harness row
 * and the test skips itself. Run locally with:
 *   node tools/fake-model-server.mjs                (default port 8899)
 *   EXPO_PUBLIC_DEV_GROUP_HTTP=http://127.0.0.1:8899 \
 *     pnpm --filter @locallab/mobile exec expo start --web --port 8081
 *   pnpm exec playwright test --config tests/ui/playwright.config.ts group-chat-stream
 */
test("phone group room streams both seats from the dev harness without gate or prefix", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 440, height: 956 });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      ["data:", "blob:"].includes(url.protocol) ||
      url.origin === new URL(testInfo.project.use.baseURL as string).origin ||
      url.origin === "http://127.0.0.1:1234" ||
      url.origin === "http://127.0.0.1:8899"
    )
      return route.continue();
    return route.abort();
  });
  // A freshly launched server bundles on demand; cold first visits can take
  // minutes, so the first expect per route gets a generous window.
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Continue without a model" }),
  ).toBeVisible({ timeout: 150_000 });
  await page.getByRole("button", { name: "Continue without a model" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible({ timeout: 150_000 });
  await page.goto("/chat?panel=groups");
  await expect(
    page.getByRole("textbox", { name: "Group name", exact: true }),
  ).toBeVisible({ timeout: 150_000 });
  await page
    .getByRole("textbox", { name: "Group name", exact: true })
    .fill("Stream Lab");
  await page
    .getByRole("textbox", { name: "Room scenario", exact: true })
    .fill("Hermetic streaming round-trip");
  await page
    .getByRole("textbox", { name: "Your display name", exact: true })
    .fill("Owner");
  // Skip-probe: the harness row only exists on a __DEV__ bundle served with
  // EXPO_PUBLIC_DEV_GROUP_HTTP set (see the header comment).
  await page.getByRole("button", { name: "Shared model", exact: true }).click();
  const harnessRow = page.getByRole("button", { name: /Choose Dev harness/ });
  const enabled = (await harnessRow.count()) > 0;
  if (!enabled) {
    await page.getByRole("button", { name: "Close Shared model" }).click();
  }
  await test.skip(!enabled, "dev group harness not enabled on this server");
  // Sheet rows can sit under the fixed setup surface once the window has
  // scrolled (RN-web scrolls the window, not the ScrollView); dispatch on
  // the resolved node like the persona rows below.
  await harnessRow.dispatchEvent("click");
  await page.getByRole("button", { name: "Close Shared model" }).click();
  await page.getByRole("button", { name: "Add participant" }).click();
  await page
    .getByRole("button", { name: "Choose Aldric Vane" })
    .dispatchEvent("click");
  await page
    .getByRole("button", { name: "Choose Sable Nyx" })
    .dispatchEvent("click");
  await page.getByRole("button", { name: "Close Add participant" }).click();
  await page.getByRole("button", { name: "Validate and save group" }).click();
  await expect(page).toHaveURL(/\/group-chat\?roomId=/, { timeout: 150_000 });
  // A bound room must never show the "no shared model" gate.
  await expect(
    page.getByRole("alert").filter({ hasText: "no shared model" }),
  ).toHaveCount(0);
  const composer = page.getByRole("textbox", {
    name: "Group message composer",
  });
  await composer.fill("ping the room from the stream spec");
  await page.getByRole("button", { name: "Send message to the room" }).click();
  const transcript = page.getByRole("region", {
    name: "Group transcript surface",
  });
  // Round-robin over two fresh seats: both fake beats must arrive over real
  // SSE through the OpenAI-compatible adapter.
  await expect
    .poll(() => transcript.textContent(), { timeout: 60_000 })
    .toMatch(
      /Fake beat \d+ for Aldric Vane\.[\s\S]*Fake beat \d+ for Sable Nyx\.|Fake beat \d+ for Sable Nyx\.[\s\S]*Fake beat \d+ for Aldric Vane\./,
    );
  // The fake server echoes "Name: reply" verbatim; the room strip must keep
  // that prefix out of the rendered transcript.
  const text = (await transcript.textContent()) ?? "";
  expect(text).not.toMatch(/(^|\n)(Aldric Vane|Sable Nyx): /);
  await page.screenshot({
    path: testInfo.outputPath("group-chat-stream.png"),
    fullPage: false,
  });
});
