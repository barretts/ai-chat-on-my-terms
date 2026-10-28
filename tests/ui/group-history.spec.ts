import { expect, test } from "@playwright/test";

/**
 * A group room is a chat (T170 mapping): after saving a room from the setup
 * panel, the Recent chats list shows it by room name with the group kind in
 * its VoiceOver label, tapping it enters /group-chat, and the solo chat that
 * happened to be open during setup stays an untouched solo row.
 *
 * Run with the same hermetic lane as the spacing spec (no dev harness needed):
 *   pnpm exec playwright test --config tests/ui/playwright.config.ts group-history
 */
test("phone saves a room as a chat row that reopens into the room screen", async ({
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
  const name = page.getByRole("textbox", { name: "Group name", exact: true });
  await name.waitFor({ timeout: 150_000 });
  await name.fill("Fog Horns");
  await page
    .getByRole("textbox", { name: "Your display name", exact: true })
    .fill("Owner");
  await page.getByRole("button", { name: "Add participant" }).click();
  await page
    .getByRole("button", { name: "Choose Aldric Vane" })
    .dispatchEvent("click");
  await page
    .getByRole("button", { name: "Choose Sable Nyx" })
    .dispatchEvent("click");
  await page
    .getByRole("button", { name: "Close Add participant" })
    .dispatchEvent("click");
  await page.getByRole("button", { name: "Validate and save group" }).click();
  await expect(page).toHaveURL(/\/group-chat\?roomId=/, { timeout: 150_000 });
  // The reopened room must announce itself, not just show a transcript.
  await expect(
    page.getByRole("heading", { name: "Fog Horns" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("group-history-room.png"),
    fullPage: false,
  });
  // "Chats" returns toward the list the room was opened from.
  await page.getByRole("button", { name: "Back to Recent chats" }).click();
  await expect(page).toHaveURL(/\/chat/);
  await page.goto("/chat?panel=history");
  const roomRow = page.getByRole("button", {
    name: /^Fog Horns, group chat, /,
  });
  await expect(roomRow).toBeVisible({ timeout: 150_000 });
  // The solo chat open during setup is still its own solo row: the room
  // minted its own conversation instead of riding the current chat.
  await expect(
    page.getByRole("button", { name: /^Offline chat,/ }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("group-history-list.png"),
    fullPage: false,
  });
  await roomRow.click();
  await expect(page).toHaveURL(/\/group-chat\?roomId=/, { timeout: 30_000 });
});
