import { expect, test, type Page, type TestInfo } from "@playwright/test";

const modelId = "auto-context-fixture";

type FixtureRequest = {
  origin: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
};

async function installContextFixtures(
  page: Page,
  testInfo: TestInfo,
  capacities: Record<string, number>,
) {
  const requests: FixtureRequest[] = [];
  const discoveries: string[] = [];
  const runtimeErrors: string[] = [];
  const blockedOrigins: string[] = [];
  const localOrigin = new URL(testInfo.project.use.baseURL as string).origin;
  page.on("pageerror", (cause) => runtimeErrors.push(cause.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["data:", "blob:"].includes(url.protocol) || url.origin === localOrigin)
      return route.continue();
    if (!(url.origin in capacities)) {
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
    if (url.pathname === "/v1/models") {
      expect(route.request().method()).toBe("GET");
      discoveries.push(url.origin);
      return route.fulfill({
        headers,
        json: {
          data: [{ id: modelId, max_model_len: capacities[url.origin] }],
        },
      });
    }
    expect(url.pathname).toBe("/v1/chat/completions");
    expect(route.request().method()).toBe("POST");
    requests.push({ origin: url.origin, ...route.request().postDataJSON() });
    const reply = `Response from ${url.hostname}.`;
    return route.fulfill({
      headers: { ...headers, "content-type": "text/event-stream" },
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
    });
  });
  return { requests, discoveries, runtimeErrors, blockedOrigins };
}

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const contextWindow = (page: Page) =>
  page.getByRole("textbox", { name: "Context window", exact: true });

async function addConnection(page: Page, label: string, endpoint: string) {
  await page.goto("/chat?panel=connections");
  const add = button(page, "Add provider");
  await expect(add.or(button(page, "Other")).first()).toBeVisible();
  if (await add.isVisible()) await add.click();
  await button(page, "Other").click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill(label);
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill(endpoint);
  await button(page, "Load endpoint models").click();
  await expect(page.getByText(/Found 1 models/)).toBeVisible();
  await button(page, "Save and use provider").click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
}

async function selectPersona(page: Page, name: string, persona: string) {
  await button(page, "Open chat menu").click();
  await button(page, "More tools").click();
  await button(page, "Personas").click();
  await button(page, "Create Persona").click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill(persona);
  await button(page, "Save Persona profile").click();
  await button(page, `Use ${name} in current chat`).click();
}

async function openContextSettings(page: Page, capacity: number) {
  await button(page, "Open chat menu").click();
  await button(page, "Settings").click();
  await showContextSettings(page, capacity);
}

async function showContextSettings(page: Page, capacity: number) {
  await expect(button(page, "Advanced model controls")).toBeVisible();
  if (!(await contextWindow(page).isVisible()))
    await button(page, "Advanced model controls").click();
  await expect(
    page.getByText(
      `Server context: ${capacity.toLocaleString("en-US")} tokens. Used automatically unless you set Context window.`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(contextWindow(page)).toBeEnabled();
}

async function returnToChat(page: Page) {
  await expect(
    page.getByText("Saving settings...", { exact: true }),
  ).toHaveCount(0);
  await button(page, "Return to conversation").click();
}

test("phone uses server context for a large special character persona and restores it after an explicit override", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 956 });
  const origin = "https://automatic-context-fixture.example";
  const capacities = {
    [origin]: 65_536,
  };
  const fixture = await installContextFixtures(page, testInfo, capacities);
  const persona = [
    '# Persona "owl"',
    "**Keep Markdown** and `code` intact.",
    '<persona voice="calm">a & b; 日本語; 🦉</persona>',
    '```xml\n<example path="C:\\tmp\\owl"/>\n```',
    "X".repeat(27_000),
  ].join("\n");
  const draft =
    'Explain <tag attr="value">a & b</tag>.\n```xml\n<example/>\n```\nEmoji 🦉; 日本語; path C:\\tmp\\x; quote "hello".';
  const retryDraft = "The server context should still fit this persona.";
  await page.goto("/");
  await button(page, "Continue without a model").click();
  await addConnection(page, "Automatic context fixture", `${origin}/v1`);
  await selectPersona(page, "Large special character persona", persona);

  await openContextSettings(page, 65_536);
  await expect(contextWindow(page)).toHaveValue("65536");
  await expect(button(page, "Context window: Reset this value")).toHaveCount(0);
  await contextWindow(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-automatic-server-context.png`,
    fullPage: true,
  });
  await returnToChat(page);
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByTestId("advanced-composer-send");
  await message.fill(draft);
  await send.click();
  await expect(page.getByTestId("assistant-response-text")).toHaveAttribute(
    "aria-label",
    "Response from automatic-context-fixture.example.",
  );
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]).toMatchObject({ origin, model: modelId });
  expect(fixture.requests[0].messages).toEqual([
    { role: "system", content: persona },
    { role: "user", content: draft },
  ]);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await openContextSettings(page, 65_536);
  await button(page, "Settings scope").click();
  await expect(
    page.getByRole("tab", { name: "This chat", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await contextWindow(page).fill("4096");
  await button(page, "Advanced model controls").click();
  await returnToChat(page);
  await message.fill(retryDraft);
  await send.click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveCount(1);
  await expect(alert).toContainText(
    "Required instructions and the current message",
  );
  await expect(alert).toContainText(
    "input budget is 3584 (4096 context tokens minus 512 reserved for the response)",
  );
  await expect(alert).toContainText("draft is preserved");
  await expect(message).toHaveValue(retryDraft);
  expect(fixture.requests).toHaveLength(1);
  await button(page, "Adjust context settings").click();
  await showContextSettings(page, 65_536);
  await expect(contextWindow(page)).toHaveValue("4096");
  await button(page, "Context window: Reset this value").click();
  await expect(contextWindow(page)).toHaveValue("65536");
  await returnToChat(page);
  await expect(message).toHaveValue(retryDraft);
  await send.click();
  await expect(page.getByTestId("assistant-response-text")).toHaveCount(2);
  await expect(
    page.getByText("Response complete", { exact: true }).last(),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(message).toHaveValue("");
  expect(fixture.requests).toHaveLength(2);
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: persona },
    { role: "user", content: draft },
    {
      role: "assistant",
      content: "Response from automatic-context-fixture.example.",
    },
    { role: "user", content: retryDraft },
  ]);

  // The same model can restart at a smaller context without changing its URL.
  // A fresh send must use its active limit rather than the previous 64K value.
  capacities[origin] = 4_096;
  const restartedDraft = "Use the active context after this server restarted.";
  await message.fill(restartedDraft);
  await send.click();
  await expect(alert).toContainText(
    "input budget is 3584 (4096 context tokens minus 512 reserved for the response)",
  );
  await expect(message).toHaveValue(restartedDraft);
  expect(fixture.requests).toHaveLength(2);
  await button(page, "Adjust context settings").click();
  await showContextSettings(page, 4_096);
  await expect(contextWindow(page)).toHaveValue("4096");
  await expect(button(page, "Context window: Reset this value")).toHaveCount(0);
  await returnToChat(page);
  capacities[origin] = 65_536;
  await send.click();
  await expect(page.getByTestId("assistant-response-text")).toHaveCount(3);
  await expect(
    page.getByText("Response complete", { exact: true }).last(),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(message).toHaveValue("");
  expect(fixture.requests).toHaveLength(3);
  expect(fixture.requests[2].messages[0]).toEqual({
    role: "system",
    content: persona,
  });
  expect(fixture.requests[2].messages.at(-1)).toEqual({
    role: "user",
    content: restartedDraft,
  });
  expect(fixture.discoveries).toContain(origin);
  expect(fixture.runtimeErrors).toEqual([]);
  expect(fixture.blockedOrigins).toEqual([]);
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-reset-to-automatic-context.png`,
    fullPage: true,
  });
});

test("phone keeps server context tied to the selected connection when model IDs match", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 956 });
  const largeOrigin = "https://large-context-fixture.example";
  const smallOrigin = "https://small-context-fixture.example";
  const fixture = await installContextFixtures(page, testInfo, {
    [largeOrigin]: 65_536,
    [smallOrigin]: 8_192,
  });
  const persona = `<persona>\n${"Z".repeat(34_000)}\n</persona>`;
  const draft =
    "Use the context from the server selected for this conversation.";
  await page.goto("/");
  await button(page, "Continue without a model").click();
  await addConnection(page, "Large context connection", `${largeOrigin}/v1`);
  await selectPersona(page, "Connection bound persona", persona);
  await openContextSettings(page, 65_536);
  await expect(contextWindow(page)).toHaveValue("65536");
  await returnToChat(page);

  await addConnection(page, "Small context connection", `${smallOrigin}/v1`);
  await openContextSettings(page, 8_192);
  await expect(contextWindow(page)).toHaveValue("8192");
  await expect(button(page, "Context window: Reset this value")).toHaveCount(0);
  await contextWindow(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-smaller-server-context.png`,
    fullPage: true,
  });
  await returnToChat(page);
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByTestId("advanced-composer-send");
  await message.fill(draft);
  await send.click();
  await expect(page.getByRole("alert")).toContainText(
    "input budget is 7680 (8192 context tokens minus 512 reserved for the response)",
  );
  await expect(message).toHaveValue(draft);
  expect(fixture.requests).toHaveLength(0);
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-connection-specific-context.png`,
    fullPage: true,
  });

  await button(page, "Open chat menu").click();
  await button(page, "Connections").click();
  await button(page, "Use saved provider Large context connection").click();
  await openContextSettings(page, 65_536);
  await expect(contextWindow(page)).toHaveValue("65536");
  await returnToChat(page);
  await expect(message).toHaveValue(draft);
  await send.click();
  await expect(page.getByTestId("assistant-response-text")).toHaveAttribute(
    "aria-label",
    "Response from large-context-fixture.example.",
  );
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]).toMatchObject({
    origin: largeOrigin,
    model: modelId,
  });
  expect(fixture.requests[0].messages).toEqual([
    { role: "system", content: persona },
    { role: "user", content: draft },
  ]);
  expect(fixture.discoveries).toContain(largeOrigin);
  expect(fixture.discoveries).toContain(smallOrigin);
  expect(fixture.runtimeErrors).toEqual([]);
  expect(fixture.blockedOrigins).toEqual([]);
});
