import { test, expect, type Page } from "@playwright/test";

async function expandSetupPreferences(page: Page) {
  const controls = page.getByRole("button", { name: /^Choose power user setup/ });
  if (await controls.count()) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const disclosure = page.getByRole("button", {
      name: "Show setup preferences",
    });
    if (await disclosure.count()) await disclosure.click();
    try {
      await controls.waitFor({ state: "visible", timeout: 3000 });
      return;
    } catch {
      // The disclosure can re-render while hydration finishes; retry.
    }
  }
  await controls.waitFor({ state: "visible" });
}

async function expectChatOpen(page: Page) {
  await expect(
    page.getByRole("heading", { name: /^(LocalLab|Offline chat)$/, exact: true }).first(),
  ).toBeVisible();
}

async function openSettings(page: Page, phone: boolean) {
  if (phone) {
    await page.getByRole("button", { name: "Open chat menu" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await expect(
    phone
      ? page.getByRole("heading", { name: "Settings", exact: true })
      : page.getByRole("heading", { name: "Chat and model settings" }),
  ).toBeVisible();
}

async function closeSettings(page: Page, phone: boolean) {
  if (phone) await page.getByRole("button", { name: "Return to conversation" }).click();
  else await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expectChatOpen(page);
}

const settingsBackground = (page: Page) =>
  page
    .getByText(/Make this chat your own|Choose which settings apply here/)
    .evaluate((element) => {
      let current: Element | null = element;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
        current = current.parentElement;
      }
      return "transparent";
    });

test("theme and setup choices visibly change, persist, and open chat", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "phone";
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
  await expandSetupPreferences(page);

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
    page.getByText(/Power user( setup)? shows/),
  ).toBeVisible();
  await page.reload();
  await expandSetupPreferences(page);
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
  await expectChatOpen(page);
  await expect(
    page.getByText("Chat storage could not be opened.", { exact: false }),
  ).toHaveCount(0);
  await page.reload();
  await expectChatOpen(page);
  if (phone) {
    await page.goto("/onboarding");
    await expect(
      page.getByRole("heading", { name: "Welcome to LocalLab" }),
    ).toBeVisible();
    await expandSetupPreferences(page);
    await expect(power).toHaveAttribute(
      "aria-label",
      "Choose power user setup, selected",
    );
  } else {
    await page.getByRole("link", { name: "Models", exact: true }).click();
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
  }
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expectChatOpen(page);
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
  await openSettings(page, phone);
  const settingsLight = page.getByRole("button", {
    name: /^Use light app theme(?:, selected)?$/,
  });
  const darkSettingsBackground = await settingsBackground(page);
  await settingsLight.click();
  let lightSettingsBackground = "";
  await expect
    .poll(async () => {
      lightSettingsBackground = await settingsBackground(page);
      return lightSettingsBackground;
    })
    .not.toBe(darkSettingsBackground);
  await closeSettings(page, phone);
  await page.reload();
  await openSettings(page, phone);
  await expect.poll(() => settingsBackground(page)).toBe(lightSettingsBackground);
  await page.screenshot({
    path: `${testInfo.outputDir}/settings-light.png`,
    fullPage: true,
  });
  expect(runtimeErrors).toEqual([]);
});

test("beginner setup opens a simpler chat and sends a durable test response", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "phone";
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
  await expandSetupPreferences(page);
  await page.getByRole("button", { name: /^Choose dark theme/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expectChatOpen(page);
  if (phone) await page.getByRole("button", { name: "Open chat menu" }).click();
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
  await page.getByRole("button", { name: "Fewer tools", exact: true }).click();
  // The beginner drawer/rail hides advanced sections; verify Memory stays
  // hidden until "More tools" expands them again.
  await expect(
    page.getByRole("button", { name: "Memory", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "More tools", exact: true }).click();
  if (phone) await page.getByRole("button", { name: "Close chat menu" }).click();

  // Route the chat through the local Responses-API fixture provider instead
  // of the seeded default connection (kind "openai" speaks the Responses API).
  if (phone) {
    await page.getByRole("button", { name: "Choose chat connection" }).click();
  } else {
    await page.getByRole("button", { name: "Providers", exact: true }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Your connections" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add provider" }).click();
  if (phone) await page.getByRole("button", { name: "Other", exact: true }).click();
  await page.getByRole("button", { name: "Provider type", exact: true }).click();
  await page.getByRole("button", { name: "Choose OpenAI" }).click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("UI fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill("https://ui-fixture.test/v1/responses");
  await page
    .getByRole("textbox", { name: "Provider API key", exact: true })
    .fill("test-key-no-network-provider");
  await page.getByRole("button", { name: "Enter custom model ID" }).click();
  await page
    .getByRole("textbox", { name: "Exact chat model ID", exact: true })
    .fill("ui-fixture");
  await page.getByRole("button", { name: "Save and use provider" }).click();
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
    path: `${testInfo.outputDir}/beginner-chat.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Hello from the local UI test", exact: true }),
  ).toBeVisible();
  const transcript = page.getByTestId("chat-transcript-scroll");
  await expect(
    transcript.getByText("Hello from the local UI test", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("Local interaction verified.", { exact: true }),
  ).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});
