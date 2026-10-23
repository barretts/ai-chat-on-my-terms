import { expect, test, type Page } from "@playwright/test";

const ownedMarkdown =
  "# Owned clipboard fixture\n\n```python\ndef add(a, b):\n    return a + b\n```\n\nUnicode: café, 日本語, 🌻.\n";
const apiBase = process.env.LOCALLAB_LIVE_API_BASE;
const model = process.env.LOCALLAB_LIVE_MODEL ?? "local-coder";

async function observeRealClipboardWrites(page: Page) {
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      ownedClipboardWrites: string[];
    };
    state.ownedClipboardWrites = [];
    const realWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => {
      state.ownedClipboardWrites.push(text);
      return realWrite(text);
    };
  });
}

async function expectOwnedClipboard(page: Page, markdown: string) {
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { ownedClipboardWrites: string[] })
          .ownedClipboardWrites,
    ),
  ).toEqual([markdown]);
  // Windows normalizes native clipboard line endings to CRLF. Only read our isolated test's own write.
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())).replace(
      /\r\n/g,
      "\n",
    ),
  ).toBe(markdown);
}

async function expandSetupPreferences(page: Page) {
  const controls = page.getByRole("button", {
    name: /^Choose power user setup/,
  });
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

async function openPowerChat(page: Page) {
  await page.goto("/");
  await expandSetupPreferences(page);
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page.getByRole("button", { name: /^Choose dark theme/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page
      .getByRole("heading", { name: /^(AI Chat|Offline chat)$/, exact: true })
      .first(),
  ).toBeVisible();
}

async function openConnectionsPanel(page: Page) {
  const heading = page.getByRole("heading", {
    name: "Your connections",
    exact: true,
  });
  try {
    await heading.first().waitFor({ state: "visible", timeout: 4000 });
    return;
  } catch {
    // The panel starts closed; open it via the rail/appbar trigger.
  }
  const appbar = page.getByRole("button", {
    name: "Choose chat connection",
  });
  if (await appbar.count()) await appbar.click();
  else
    await page
      .getByRole("button", { name: /^(Providers|Connections)$/ })
      .click();
  await expect(heading.first()).toBeVisible();
}

async function useFixtureProvider(page: Page, hold?: Promise<void>) {
  const sent: string[] = [];
  // An explicitly labeled provider fixture isolates browser keyboard and clipboard behavior.
  await page.route(
    "https://composer-fixture.test/v1/responses",
    async (route) => {
      const headers = {
        "access-control-allow-origin": "http://localhost:8081",
        "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "POST,OPTIONS",
        "content-type": "text/event-stream",
      };
      if (route.request().method() === "OPTIONS")
        return route.fulfill({ status: 204, headers });
      const user = route
        .request()
        .postDataJSON()
        .input.filter((part: { role?: string }) => part.role === "user")
        .at(-1);
      sent.push(
        typeof user.content === "string"
          ? user.content
          : user.content
              .map((part: { text?: string }) => part.text ?? "")
              .join(""),
      );
      await hold;
      await route.fulfill({
        status: 200,
        headers,
        body: `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: ownedMarkdown })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 24 } } })}\n\n`,
      });
    },
  );
  await openConnectionsPanel(page);
  await page.getByRole("button", { name: "Add provider" }).click();
  const other = page.getByRole("button", { name: "Other", exact: true });
  if (await other.count()) await other.click();
  const nameBox = page.getByRole("textbox", {
    name: "Provider name",
    exact: true,
  });
  if (!(await nameBox.count()))
    await page.getByRole("button", { name: "Connection settings" }).click();
  await page
    .getByRole("button", { name: "Provider type", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose OpenAI", exact: true })
    .click();
  await nameBox.fill("Composer fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill("https://composer-fixture.test/v1/responses");
  await page.getByRole("button", { name: "Enter custom model ID" }).click();
  await page
    .getByRole("textbox", { name: "Exact chat model ID", exact: true })
    .fill("composer-fixture");
  await page
    .getByRole("textbox", { name: "Provider API key", exact: true })
    .fill("fixture-key-no-live-provider");
  const save = page.getByRole("button", { name: "Save and use provider" });
  if (!(await save.count()))
    await page.getByRole("button", { name: "More actions" }).click();
  await save.click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  return sent;
}

test("composer mode, starters and actual Return/Shift+Return behavior persist", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "phone";
  await openPowerChat(page);
  // Composer preferences now live behind the Writing options dialog.
  const openOptions = async () => {
    // On phone the Writing options chip lives inside the message-tools
    // panel, so open that panel first.
    if (phone) {
      const panel = page.getByTestId("message-tools");
      if (!(await panel.isVisible().catch(() => false)))
        await page
          .getByRole("button", { name: /^(Show|Hide) message tools$/ })
          .click();
      await panel.waitFor({ state: "visible" });
    }
    await page.getByRole("button", { name: "Writing options" }).click();
  };
  const closeOptions = async () => {
    await page
      .getByRole("button", { name: "Done with writing options" })
      .click();
  };
  // Desktop exposes mode radios and testid switches in the dialog; the
  // phone dialog offers a Return-sends switch instead, and starter chips
  // render on desktop surfaces only by current design.
  const compact = page.getByRole("radio", { name: "Compact", exact: true });
  const shine = page.getByRole("radio", { name: "Shine", exact: true });
  const starters = page.getByTestId("composer-starters-toggle");
  const returnToggle = phone
    ? page.getByRole("switch", { name: "Return sends message", exact: true })
    : page.getByTestId("composer-return-toggle");
  await openOptions();
  if (!phone) {
    await compact.click();
    await expect(compact).toBeChecked();
    await starters.click();
    await expect(starters).not.toBeChecked();
    await expect(page.getByTestId("composer-starter-explain")).toHaveCount(0);
  }
  await returnToggle.click();
  await expect(returnToggle).not.toBeChecked();
  await closeOptions();
  await page.reload();
  await openOptions();
  if (!phone) {
    await expect(compact).toBeChecked();
    await expect(starters).not.toBeChecked();
  }
  await expect(returnToggle).not.toBeChecked();
  await closeOptions();
  // Browser API keys are intentionally held in memory, so configure the fixture after reload.
  const sent = await useFixtureProvider(page);
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("First line");
  await message.press("End");
  await message.press("Enter");
  await expect(message).toHaveValue("First line\n");
  await message.press("Shift+Enter");
  await expect(message).toHaveValue("First line\n\n");
  expect(sent).toEqual([]);
  await message.type("Final line");
  await page.getByTestId("advanced-composer-send").click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toBe("First line\n\nFinal line");
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toHaveCount(1);
  await expect(message).toHaveValue("");
  await openOptions();
  await returnToggle.click();
  await expect(returnToggle).toBeChecked();
  await closeOptions();
  await message.fill("Shift preserves a line break");
  await message.press("End");
  await message.press("Shift+Enter");
  await expect(message).toHaveValue("Shift preserves a line break\n");
  expect(sent).toHaveLength(1);
  await message.type("Return sends this once");
  await message.press("Enter");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toBe("Shift preserves a line break\nReturn sends this once");
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toHaveCount(2);
  await expect(message).toHaveValue("");
  if (phone) {
    // Starter chips are desktop-only; verify the phone design keeps them out.
    await expect(page.getByTestId("composer-starter-explain")).toHaveCount(0);
  } else {
    await openOptions();
    await shine.click();
    await starters.click();
    await closeOptions();
    await page.getByTestId("composer-starter-explain").click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2]).toBe(
      "Explain a useful programming concept with a short example.",
    );
    await expect(
      page.getByText("Response complete", { exact: true }),
    ).toHaveCount(3);
  }
  await expect(message).toHaveValue("");
  await page.reload();
  await openOptions();
  if (!phone) {
    await expect(shine).toBeChecked();
    await expect(starters).toBeChecked();
  }
  await expect(returnToggle).toBeChecked();
  await closeOptions();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toHaveCount(phone ? 2 : 3);
  await page.screenshot({
    path: testInfo.outputPath("keyboard-and-preferences.png"),
    fullPage: true,
  });
});

test("Copy preserves fenced Markdown, exposes denied permission, and Attach is disabled during a pending reply", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:8081",
  });
  await openPowerChat(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent = await useFixtureProvider(page, hold);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Produce the owned clipboard fixture.");
  await page.getByTestId("advanced-composer-send").click();
  await expect.poll(() => sent.length).toBe(1);
  if (testInfo.project.name === "phone") {
    // Attach lives inside the message-tools panel on phone.
    await page
      .getByRole("button", { name: /^(Show|Hide) message tools$/ })
      .click();
    await page.getByTestId("message-tools").waitFor({ state: "visible" });
  }
  try {
    await expect(
      page.getByRole("button", { name: "Attach", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible();
  if (testInfo.project.name === "phone") {
    // The open message-tools panel would intercept the Copy click.
    await page
      .getByRole("button", { name: /^(Close|Hide) message tools$/ })
      .click();
    await page.getByTestId("message-tools").waitFor({ state: "hidden" });
  }
  // On phone the Copy action sits beside (not inside) the response text
  // node, so scope to the enclosing message row.
  const responseRow =
    testInfo.project.name === "phone"
      ? page.getByTestId("assistant-response-text").locator("..")
      : page.getByTestId("assistant-response-text");
  const copy = responseRow.getByRole("button", {
    name: "Copy Markdown",
    exact: true,
  });
  await observeRealClipboardWrites(page);
  await copy.click();
  await expect(
    page.getByText("Markdown copied.", { exact: true }),
  ).toBeVisible();
  await expectOwnedClipboard(page, ownedMarkdown);
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  for (const allowWithoutSanitization of [false, true])
    await cdp.send("Browser.setPermission", {
      permission: { name: "clipboard-write", allowWithoutSanitization },
      setting: "denied",
      origin: "http://localhost:8081",
      browserContextId: targetInfo.browserContextId,
    });
  await copy.click();
  await expect(page.getByRole("alert")).toContainText(
    "Clipboard access was denied. Allow clipboard permission and try Copy again.",
  );
  if (testInfo.project.name === "phone") {
    // Reopen the tools panel that was closed so its Attach button is visible.
    await page
      .getByRole("button", { name: /^(Show|Hide) message tools$/ })
      .click();
    await page.getByTestId("message-tools").waitFor({ state: "visible" });
  }
  await expect(
    page.getByRole("button", { name: "Attach", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("assistant-response-text")).toContainText(
    "def add(a, b):",
  );
  await page.screenshot({
    path: testInfo.outputPath("clipboard-permission-error.png"),
    fullPage: true,
  });
});

test("a real model's fenced code reply copies its exact streamed Markdown", async ({
  page,
  context,
}, testInfo) => {
  test.skip(!apiBase, "Set LOCALLAB_LIVE_API_BASE to copy a real model reply.");
  test.setTimeout(120_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:8081",
  });
  await openPowerChat(page);
  await page.getByRole("button", { name: /^(Providers|Connections)$/ }).click();
  await page.getByRole("tab", { name: "compatible", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Clipboard local server");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill(apiBase!);
  await page
    .getByRole("textbox", { name: "Exact chat model ID", exact: true })
    .fill(model);
  await page
    .getByRole("switch", { name: "Authorize local HTTP origin", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save and use provider", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill(
      "<|think_off|>\nReturn only one fenced Python code block with the requested function.",
    );
  await page
    .getByRole("textbox", { name: "Maximum output tokens", exact: true })
    .fill("768");
  await page
    .getByRole("textbox", { name: "Maximum output tokens", exact: true })
    .press("Tab");
  await expect(
    page.getByText("Saving settings...", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const responsePromise = page.waitForResponse((response) => {
    const target =
      new URL(response.url()).searchParams.get("url") ?? response.url();
    return (
      target.endsWith("/chat/completions") &&
      response.request().method() === "POST" &&
      response.status() === 200
    );
  });
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(
      "Write a Python function add(a, b) that returns a + b. Use exactly one fenced python code block and no explanation.",
    );
  await page.getByTestId("advanced-composer-send").click();
  const response = await responsePromise;
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  const source = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data).choices?.[0]?.delta?.content ?? "")
    .join("");
  expect(source).toMatch(/```python\s+def add\(a, b\):\s+return a \+ b\s+```/);
  const primary = page.getByTestId("assistant-response-text");
  await expect(primary).toContainText("def add(a, b):");
  await expect(primary).toBeInViewport({ ratio: 0.9 });
  await observeRealClipboardWrites(page);
  await primary
    .getByRole("button", { name: "Copy Markdown", exact: true })
    .click();
  await expect(
    page.getByText("Markdown copied.", { exact: true }),
  ).toBeVisible();
  await expectOwnedClipboard(page, source);
  await testInfo.attach("actual-streamed-markdown", {
    body: source,
    contentType: "text/markdown",
  });
  await page.screenshot({
    path: testInfo.outputPath("actual-code-copied.png"),
    fullPage: true,
  });
});
