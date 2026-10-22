import { expect, test } from "@playwright/test";

/**
 * Hermetic lane proof (T179 tasks 3-4): the group setup surface carries the
 * 16px/12px spacing tokens on the web client, a room saves end-to-end with
 * seeded trope personas as seats, and the group-chat route gates honestly on
 * web (local GGUF inference is unavailable in browsers; the room must show the
 * explicit "no shared model" notice instead of hanging).
 */
test("phone group setup keeps 16px spacing, saves a room, and the room gates web GGUF absence", async ({
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
  await page.goto("/chat?panel=groups");
  const surface = page.getByRole("region", { name: "Group setup surface" });
  await expect(surface).toBeVisible();
  await expect(surface).toHaveCSS("padding", "16px");
  await expect(surface).toHaveCSS("gap", "12px");
  await page
    .getByRole("textbox", { name: "Group name", exact: true })
    .fill("Hermetic Lab Room");
  await page
    .getByRole("textbox", { name: "Room scenario", exact: true })
    .fill("Debug room for the hermetic lane");
  await page
    .getByRole("textbox", { name: "Your display name", exact: true })
    .fill("Owner");
  await page.getByRole("button", { name: "Add participant" }).click();
  await page.getByRole("button", { name: "Choose Aldric Vane" }).click();
  // After the first pick the sheet re-scrolls under the surface (RN-web
  // scrolls the window, not the ScrollView), so hit-testing cannot reach the
  // second row; dispatch directly on the resolved button instead.
  await page
    .getByRole("button", { name: "Choose Sable Nyx" })
    .dispatchEvent("click");
  await page.getByRole("button", { name: "Close Add participant" }).click();
  await page.getByRole("button", { name: "Validate and save group" }).click();
  await expect(page).toHaveURL(/\/group-chat\?roomId=/);
  // The setup panel's hidden "No shared model" dropdown option also matches
  // plain text search; the route's gate is announced through an alert.
  await expect(
    page.getByRole("alert").filter({ hasText: "no shared model" }),
  ).toBeVisible();
});
