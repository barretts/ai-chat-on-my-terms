import { expect, test } from "@playwright/test";

test("the Tools settings panel works with no network traffic at all", async ({
  page,
}, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (cause) => runtimeErrors.push(cause.message));
  const external: string[] = [];
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host))
      external.push(route.request().url());
    return route.continue();
  });
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  const phone = (page.viewportSize()?.width ?? 0) <= 600;

  await page.goto("/");
  await button("Continue without a model").click();
  await expect(page.getByTestId("advanced-composer-input")).toBeVisible();

  if (phone) await button("Open chat menu").click();
  await button("Tools").click();
  const master = page.getByRole("switch", { name: "Use tools in this app" });
  await expect(master).toBeChecked();
  await expect(page.getByTestId("tool-settings-round-limit")).toBeVisible();
  const webSearch = page.getByRole("switch", {
    name: "Enable Web search in this app",
  });
  await expect(webSearch).toBeChecked();
  await expect(
    page.getByRole("switch", { name: "Enable Current time in this app" }),
  ).toBeChecked();
  await expect(
    page.getByText("Renaming changes only what you see"),
  ).toBeVisible();

  // MCP servers: explicit add, disabled by default, honest offline answers.
  await expect(page.getByTestId("tool-settings-mcp")).toBeVisible();
  await page.getByLabel("MCP server name").fill("Local check");
  await page.getByLabel("MCP server URL").fill("http://127.0.0.1:39111/mcp");
  await button("Add MCP server").click();
  const mcpSwitch = page.getByRole("switch", {
    name: "Enable MCP server Local check",
  });
  await expect(mcpSwitch).toBeVisible();
  await expect(mcpSwitch).not.toBeChecked();
  await button("Check MCP server Local check").click();
  await expect(page.getByTestId("tool-settings-mcp-notice")).toContainText(
    "Could not reach MCP server",
  );
  await button("Remove MCP server Local check").click();
  await expect(mcpSwitch).toHaveCount(0);

  // LM Studio integrations: host names only, disabled until allowed,
  // renaming keeps the reference sent to LM Studio.
  await expect(page.getByTestId("tool-settings-lmstudio")).toBeVisible();
  await page.getByLabel("LM Studio integration name").fill("playwright");
  await button("Add LM Studio integration").click();
  const integrationSwitch = page.getByRole("switch", {
    name: "Enable LM Studio integration mcp/playwright",
  });
  await expect(integrationSwitch).toBeVisible();
  await expect(integrationSwitch).not.toBeChecked();
  await expect(
    page.getByText("Sent to LM Studio as: mcp/playwright"),
  ).toBeVisible();
  const display = page.getByLabel(
    "Display name for LM Studio integration mcp/playwright",
  );
  await display.fill("Browser tools");
  await display.press("Tab");
  await integrationSwitch.click();
  await expect(integrationSwitch).toBeChecked();
  if (!phone) {
    await button("Back to chat from tool settings").click();
    await button("Tools").click();
    await expect(display).toHaveValue("Browser tools");
    await expect(integrationSwitch).toBeChecked();
  }
  await button("Remove LM Studio integration mcp/playwright").click();
  await expect(integrationSwitch).toHaveCount(0);

  // Disable one tool; on desktop a close-and-reopen must show the saved state.
  await webSearch.click();
  await expect(webSearch).not.toBeChecked();
  if (!phone) {
    await button("Back to chat from tool settings").click();
    await button("Tools").click();
    await expect(webSearch).not.toBeChecked();
  }

  // The master switch turns every tool off for new messages.
  await master.click();
  await expect(webSearch).toBeDisabled();
  await expect(page.getByText("off everywhere").first()).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/${testInfo.project.name}-tool-settings.png`,
    fullPage: true,
  });
  expect(external).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});
