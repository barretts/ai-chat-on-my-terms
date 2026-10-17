import { expect, test } from "@playwright/test";

test("phone preserves an oversized persona draft and sends exact special characters after adjusting context", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 956 });
  const endpoint = "https://persona-context-fixture.example/v1";
  const name = "Special character persona";
  const persona = [
    '# Persona "owl"',
    "**Use Markdown** and `code` without changing these instructions.",
    '<persona voice="calm">a & b; 日本語; 🦉</persona>',
    '```xml\n<example path="C:\\tmp\\owl"/>\n```',
    "X".repeat(4_000),
  ].join("\n");
  const draft =
    'Explain <tag attr="value">a & b</tag>.\n```xml\n<example/>\n```\nEmoji 🦉; 日本語; path C:\\tmp\\x; quote "hello".';
  const reply = "The persona and your question arrived unchanged.";
  const runtimeErrors: string[] = [];
  const blockedOrigins: string[] = [];
  const requests: Array<{
    model: string;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  page.on("pageerror", (cause) => runtimeErrors.push(cause.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      ["data:", "blob:"].includes(url.protocol) ||
      url.origin === new URL(testInfo.project.use.baseURL as string).origin
    )
      return route.continue();
    // The machine-seeded default provider (default-chat-connection.ts) is probed
    // by the app itself; that first-party local traffic is not third-party content.
    if (url.origin === "http://127.0.0.1:1234") return route.continue();
    if (url.origin !== new URL(endpoint).origin) {
      blockedOrigins.push(url.origin);
      return route.abort();
    }
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "content-type": "application/json",
    };
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (url.pathname.includes("/models"))
      return route.fulfill({
        headers,
        json: { data: [{ id: "persona-chat-fixture" }] },
      });
    if (url.pathname.endsWith("/embeddings"))
      return route.fulfill({
        headers,
        json: { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] },
      });
    if (route.request().method() === "GET")
      return route.fulfill({ headers, json: { data: [] } });
    expect(url.pathname).toBe("/v1/chat/completions");
    expect(route.request().method()).toBe("POST");
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      headers: { ...headers, "content-type": "text/event-stream" },
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
    });
  });
  const openSettings = async () => {
    const menu = button("Open chat menu");
    if (await menu.count()) {
      await menu.click();
      const more = button("More tools");
      if (await more.count()) await more.click();
    }
    await button("Settings").click();
    await expect(
      page.getByText("Advanced model controls", { exact: true }).first(),
    ).toBeVisible();
  };
  const setContext = async (context: string) => {
    const window = page.getByRole("textbox", {
      name: "Context window",
      exact: true,
    });
    const advanced = button("Advanced model controls");
    if (
      !(await window.isVisible().catch(() => false)) &&
      (await advanced.count())
    )
      await advanced.click();
    await expect(window).toBeEnabled();
    await window.fill(context);
    if ((await advanced.count()) && (await window.isVisible().catch(() => false)))
      await advanced.click();
    await expect(
      page.getByText(
        "Context settings changed. Reload model context to apply them.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Saving settings...", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", {
        name: /^(Return to conversation|Back to (conversation|chat))$/,
      })
      .first()
      .click();
  };

  await page.goto("/");
  await button("Continue without a model").click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.goto("/chat?panel=connections");
  await expect(
    page.getByRole("heading", { name: "Your connections", exact: true }),
  ).toBeVisible();
  const add = button("Add provider");
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
  const other = button("Other");
  if (await other.count()) await other.click();
  const providerName = page.getByRole("textbox", {
    name: "Provider name",
    exact: true,
  });
  if (!(await providerName.count())) {
    const fold = button("Connection settings");
    if (await fold.count()) await fold.click();
  }
  await providerName.waitFor({ state: "visible" });
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Persona context fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill(endpoint);
  await button("Load endpoint models").click();
  await expect(page.getByText(/Found 1 models/)).toBeVisible();
  await button("Save and use provider").click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await button("Open chat menu").click();
  await button("More tools").click();
  await button("Personas").click();
  await button("Create Persona").click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill(persona);
  await button("Save Persona profile").click();
  // Saving the profile does not attach it to the conversation; the shipped
  // persona list requires an explicit "Use … in current chat" before the
  // system prompt participates (same flow as automatic-context.spec.ts).
  await button(`Use ${name} in current chat`).click();
  await openSettings();
  await setContext("1024");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByTestId("advanced-composer-send");
  await message.fill(draft);
  await send.click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveCount(1);
  await expect(alert).toContainText(
    "Required instructions and the current message",
  );
  await expect(alert).toContainText(
    "input budget is 1 (1024 context tokens minus 1023 reserved for the response)",
  );
  await expect(alert).toContainText(
    "Shorten the persona/instructions or message",
  );
  await expect(alert).toContainText("draft is preserved");
  await expect(message).toHaveValue(draft);
  expect(requests).toHaveLength(0);
  await expect(button("Copy error")).toBeVisible();
  await expect(button("Adjust context settings")).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-persona-budget-error.png`,
    fullPage: true,
  });

  await button("Adjust context settings").click();
  await expect(button("Advanced model controls")).toBeVisible();
  await setContext("4096");
  await expect(message).toHaveValue(draft);
  await send.click();
  await expect(page.getByTestId("assistant-response-text")).toHaveAttribute(
    "aria-label",
    reply,
  );
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(message).toHaveValue("");
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe("persona-chat-fixture");
  expect(requests[0].messages).toEqual([
    { role: "system", content: persona },
    { role: "user", content: draft },
  ]);
  expect(runtimeErrors).toEqual([]);
  expect(blockedOrigins).toEqual([]);
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-persona-recovered.png`,
    fullPage: true,
  });
});
