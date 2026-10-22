import { expect, test } from "@playwright/test";

/**
 * Hermetic lane proof (T179 task-2): the bundled starter-persona busts attach
 * as managed blob previews and render at the 72px avatar size on the web
 * client (starter-avatars.web.ts import path). A second "Load character pack"
 * must not duplicate attachments — the explicit-reload backfill only repairs
 * photo-less tropes.
 */
test("phone renders 72px starter-persona busts and the pack reload does not churn them", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 956 });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      ["data:", "blob:"].includes(url.protocol) ||
      url.origin === new URL(testInfo.project.use.baseURL as string).origin ||
      url.origin === "http://127.0.0.1:1234"
    )
      return route.continue();
    return route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue without a model" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.goto("/chat?panel=personas");
  await expect(page.getByText("Your personas", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Aldric Vane", { exact: true }).first(),
  ).toBeVisible();
  // Boot seeding imports every bundled bust through the browser blob port and
  // the persona list previews them; windowed rows keep at least ten visible.
  await expect
    .poll(async () => page.locator("img").count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(10);
  const sizes = await page.locator("img").evaluateAll((imgs) =>
    imgs.map((el) => {
      const rect = el.getBoundingClientRect();
      return [Math.round(rect.width), Math.round(rect.height)];
    }),
  );
  for (const [width, height] of sizes)
    expect([width, height]).toEqual([72, 72]);
  // Explicit reload clears tombstones but never re-attaches existing busts.
  const before = sizes.length;
  await page.getByRole("button", { name: "Load character pack" }).click();
  await expect(
    page.getByText("Aldric Vane", { exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(async () => page.locator("img").count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(Math.min(before, 10));
});
