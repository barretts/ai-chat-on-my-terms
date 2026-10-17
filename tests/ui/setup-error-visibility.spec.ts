import { expect, test } from "@playwright/test";

test("phone connection errors show endpoint/status, copy complete details, open trace and recover by retry", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 956 });
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.addInitScript(() => {
    Object.assign(window, { fixtureCopiedError: "" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          Object.assign(window, { fixtureCopiedError: value });
        },
      },
    });
  });
  let status = 403;
  let calls = 0;
  const endpoint = "https://setup-error-fixture.example/v1";
  const fixtureKey = "locallab-ui-fixture-not-a-real-key";
  await page.route(`${endpoint}/**`, async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
    calls++;
    if (status !== 200)
      return route.fulfill({
        status,
        headers: { "access-control-allow-origin": "*" },
        json: { error: { message: `${fixtureKey} private upstream body` } },
      });
    return route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: { data: [{ id: "setup-fixture-model" }] },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await page.goto("/chat?panel=connections");
  await expect(
    page.getByRole("heading", { name: "Your connections", exact: true }),
  ).toBeVisible();
  const add = page.getByRole("button", { name: "Add provider" });
  const editor = page.getByRole("region", {
    name: "Provider connection editor",
  });
  // The panel's provider-list reload can close a freshly opened editor; retry.
  for (let attempt = 0; attempt < 4; attempt++) {
    await add.first().click();
    if (
      await editor
        .waitFor({ state: "visible", timeout: 2500 })
        .then(() => true)
        .catch(() => false)
    )
      break;
  }
  await expect(editor).toBeVisible();
  const other = page.getByRole("button", { name: "Other", exact: true });
  if (await other.count()) await other.click();
  const providerName = page.getByRole("textbox", {
    name: "Provider name",
    exact: true,
  });
  if (!(await providerName.count())) {
    const fold = page.getByRole("button", { name: "Connection settings" });
    if (await fold.count()) await fold.click();
  }
  await providerName.waitFor({ state: "visible" });
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Connection fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill(endpoint);
  await page
    .getByRole("textbox", { name: "Provider API key", exact: true })
    .fill(fixtureKey);
  await page
    .getByRole("button", { name: "Load endpoint models", exact: true })
    .click();
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Load endpoint models failed." });
  await expect(error).toBeVisible();
  await expect(error).toContainText("HTTP 403");
  await expect(error).toContainText(`${endpoint}/models`);
  await expect(error).toContainText(
    "Check the endpoint, server status, API key and selected model",
  );
  await expect(error).not.toContainText(fixtureKey);
  await expect(error).toContainText("private upstream body");
  const bounds = await error.boundingBox();
  expect(bounds?.y).toBeGreaterThanOrEqual(0);
  expect(bounds?.y).toBeLessThan(260);
  await page.getByRole("button", { name: "Copy error", exact: true }).click();
  await expect(page.getByText("Error copied.", { exact: true })).toBeVisible();
  const copied = await page.evaluate(
    () => Reflect.get(window, "fixtureCopiedError") as string,
  );
  expect(copied).toContain("Load endpoint models failed.");
  expect(copied).toContain("HTTP 403");
  expect(copied).toContain(`${endpoint}/models`);
  expect(copied).not.toContain(fixtureKey);
  expect(copied).toContain("private upstream body");
  await page.getByRole("button", { name: "Trace log", exact: true }).click();
  await expect(
    page.getByText("Troubleshooting", { exact: true }),
  ).toBeVisible();
  const traceDialog = page.getByRole("dialog", {
    name: "Trace log",
    exact: true,
  });
  const settledDialog = async () => {
    await expect
      .poll(() =>
        traceDialog.evaluate((element) => {
          let opacity = 1;
          let current: Element | null = element;
          while (current) {
            opacity *= Number(getComputedStyle(current).opacity);
            current = current.parentElement;
          }
          return opacity;
        }),
      )
      .toBe(1);
  };
  await settledDialog();
  const recording = page.getByRole("switch", {
    name: "Record trace log",
    exact: true,
  });
  await expect(recording).toBeEnabled();
  await recording.click();
  await expect(
    page.getByText("Trace recording is on. Reproduce the problem now.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  status = 200;
  await page
    .getByRole("button", { name: "Load endpoint models", exact: true })
    .click();
  await expect(
    page.getByText(/^Found 1 models on your endpoint/),
  ).toBeVisible();
  await expect(error).toHaveCount(0);
  status = 429;
  const testConnection = page.getByRole("button", {
    name: "Test connection",
    exact: true,
  });
  if (!(await testConnection.isVisible()))
    await page
      .getByRole("button", { name: "More actions", exact: true })
      .click();
  await testConnection.click();
  const rateError = page
    .getByRole("alert")
    .filter({ hasText: "Test provider connection failed." });
  await expect(rateError).toBeVisible();
  await expect(rateError).toContainText("HTTP 429");
  expect((await rateError.boundingBox())?.y).toBeLessThan(260);
  expect(calls).toBe(3);
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-connection-full-error.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Trace log", exact: true }).click();
  await expect(page.getByText(/Test provider connection/).last()).toBeVisible();
  await settledDialog();
  expect(
    await page.getByText("Troubleshooting", { exact: true }).textContent(),
  ).not.toContain(fixtureKey);
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-error-trace-log.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(runtimeErrors).toEqual([]);
});
