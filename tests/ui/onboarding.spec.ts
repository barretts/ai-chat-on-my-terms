import { test, expect } from "@playwright/test";

test("theme and setup choices visibly change, persist, and open chat", async ({
  page,
}, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("Chat initialization failed")
    )
      runtimeErrors.push(message.text());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to LocalLab" }),
  ).toBeVisible();

  const dark = page.getByRole("button", {
    name: /^Choose dark theme(?:, selected)?$/,
  });
  const light = page.getByRole("button", {
    name: /^Choose light theme(?:, selected)?$/,
  });
  await dark.click();
  await expect(dark).toHaveAttribute(
    "aria-label",
    "Choose dark theme, selected",
  );
  const background = () =>
    page
      .getByText("Welcome to LocalLab", { exact: true })
      .evaluate((element) => {
        let current: Element | null = element;
        while (current) {
          const color = getComputedStyle(current).backgroundColor;
          if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent")
            return color;
          current = current.parentElement;
        }
        return "transparent";
      });
  const darkBackground = await background();
  await light.click();
  await expect(light).toHaveAttribute(
    "aria-label",
    "Choose light theme, selected",
  );
  await expect.poll(background).not.toBe(darkBackground);
  await dark.click();

  const power = page.getByRole("button", {
    name: /^Choose power user setup(?:, selected)?$/,
  });
  await power.click();
  await expect(power).toHaveAttribute(
    "aria-label",
    "Choose power user setup, selected",
  );
  await expect(
    page.getByText(/Power user setup shows model size/),
  ).toBeVisible();
  await page.reload();
  await expect(dark).toHaveAttribute(
    "aria-label",
    "Choose dark theme, selected",
  );
  await expect(power).toHaveAttribute(
    "aria-label",
    "Choose power user setup, selected",
  );
  await expect.poll(background).toBe(darkBackground);
  await page.screenshot({
    path: `${testInfo.outputDir}/onboarding-dark.png`,
    fullPage: true,
  });

  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your conversation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Chat storage could not be opened.", { exact: false }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your conversation", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open Models", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Get Started setup", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Get Started setup", exact: true })
    .click();
  await expect(power).toHaveAttribute(
    "aria-label",
    "Choose power user setup, selected",
  );
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your conversation", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: `${testInfo.outputDir}/chat-dark.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Chat and model settings" }),
  ).toBeVisible();
  const settingsLight = page.getByRole("button", {
    name: /^Use light app theme(?:, selected)?$/,
  });
  await settingsLight.click();
  await expect(settingsLight).toHaveAttribute(
    "aria-label",
    "Use light app theme, selected",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settingsLight).toHaveAttribute(
    "aria-label",
    "Use light app theme, selected",
  );
  expect(runtimeErrors).toEqual([]);
});

test("beginner setup opens a simpler chat and sends a durable test response", async ({
  page,
}, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  let postedMessage = false;
  await page.route("https://ui-fixture.test/v1/responses", async (route) => {
    const headers = {
      "access-control-allow-origin": new URL(page.url()).origin,
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "POST,OPTIONS",
      "content-type": "text/event-stream",
    };
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const body = route.request().postDataJSON();
    postedMessage = JSON.stringify(body).includes(
      "Hello from the local UI test",
    );
    await route.fulfill({
      status: 200,
      headers,
      body: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Local interaction verified."}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":4}}}\n\n',
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to LocalLab" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Choose dark theme/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your conversation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "More tools", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Memory", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "More tools", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Memory", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await page
    .getByRole("button", { name: "Set up OpenAI", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Responses endpoint URL", exact: true })
    .fill("https://ui-fixture.test/v1/responses");
  await page
    .getByRole("textbox", { name: "OpenAI model ID", exact: true })
    .fill("ui-fixture");
  await page
    .getByLabel("OpenAI API key", { exact: true })
    .fill("test-key-no-network-provider");
  await page
    .getByRole("button", {
      name: "Save OpenAI endpoint and model",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hello from the local UI test");
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Local interaction verified.", { exact: true }),
  ).toBeVisible();
  expect(postedMessage).toBe(true);
  await page.screenshot({
    path: `${testInfo.outputDir}/chat-test-response.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your conversation", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await expect(
    page.getByText("Hello from the local UI test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Local interaction verified.", { exact: true }),
  ).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});
