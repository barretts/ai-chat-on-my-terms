import { test, expect, type Page } from "@playwright/test";

async function saveConnection(
  page: Page,
  name: string,
  origin: string,
  kind = "llama.cpp",
) {
  await page
    .getByRole("button", { name: "Add a new connection", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Connection name", exact: true })
    .fill(name);
  await page
    .getByRole("textbox", { name: "Provider type", exact: true })
    .fill(kind);
  await page
    .getByRole("textbox", { name: "Server host", exact: true })
    .fill(origin);
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByText("Connection saved on this device.", { exact: true }),
  ).toBeVisible();
}

async function openChat(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to LocalLab" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "LocalLab Chat", exact: true }),
  ).toBeVisible();
}

test("connection CRUD, test, header replacement and ordering persist without duplicates", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const seenHeaders: Array<Record<string, string>> = [];
  await page.route(
    "https://connections-ui-fixture.test/v1/models",
    async (route) => {
      seenHeaders.push(route.request().headers());
      await route.fulfill({ json: { data: [{ id: "fixture-model" }] } });
    },
  );
  await page.goto("/connections");
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await saveConnection(
    page,
    "Primary server",
    "https://connections-ui-fixture.test",
  );
  await expect(
    page.getByRole("button", { name: "Test selected connection", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit Primary server", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Test selected connection", exact: true })
    .click();
  await expect(
    page.getByText("Connection succeeded.", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("textbox", { name: "Custom header name", exact: true })
    .fill("X-Test-Header");
  await page
    .getByLabel("Custom header value", { exact: true })
    .fill("first-test-value");
  await page
    .getByRole("switch", { name: "Enable custom headers", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByLabel("Custom header value", { exact: true }),
  ).toHaveValue("");
  await page
    .getByLabel("Custom header value", { exact: true })
    .fill("replacement-test-value");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByLabel("Custom header value", { exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Test selected connection", exact: true })
    .click();
  await expect(
    page.getByText("Connection succeeded.", { exact: true }),
  ).toBeVisible();
  expect(seenHeaders.at(-1)?.["x-test-header"]).toBe("replacement-test-value");
  await expect(
    page.getByText("replacement-test-value", { exact: true }),
  ).toHaveCount(0);

  await saveConnection(page, "Backup server", "https://backup-ui-fixture.test");
  await page
    .getByRole("button", { name: "Move Backup server up", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Edit (Primary|Backup) server$/ }),
  ).toHaveText(["Edit", "Edit"]);
  await expect(
    page
      .getByRole("button", { name: /^Edit (Primary|Backup) server$/ })
      .first(),
  ).toHaveAttribute("aria-label", "Edit Backup server");
  await page.reload();
  await expect(
    page
      .getByRole("button", { name: /^Edit (Primary|Backup) server$/ })
      .first(),
  ).toHaveAttribute("aria-label", "Edit Backup server");
  await page
    .getByRole("button", { name: "Edit Primary server", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Server host", exact: true }),
  ).toHaveValue("https://connections-ui-fixture.test");
  await page
    .getByRole("textbox", { name: "Custom header name", exact: true })
    .fill("X-Test-Header");
  await page
    .getByLabel("Custom header value", { exact: true })
    .fill("after-reload-test-value");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByLabel("Custom header value", { exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Test selected connection", exact: true })
    .click();
  await expect(
    page.getByText("Connection succeeded.", { exact: true }),
  ).toBeVisible();
  expect(seenHeaders.at(-1)?.["x-test-header"]).toBe("after-reload-test-value");
  await page
    .getByRole("button", {
      name: "Remove custom headers from selected connection",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "Custom headers removed from this connection and secure storage.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Connection name", exact: true })
    .fill("Renamed server");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit Renamed server", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "Server host", exact: true })
    .fill("https://connections-ui-fixture.test/v1");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Connection URL must contain only scheme and host",
  );
  await page
    .getByRole("button", { name: "Delete Backup server", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit Backup server", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Edit Renamed server", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Edit Backup server", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: `${testInfo.outputDir}/connections-durable.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("compatible inventory and exact model/server choices persist and become chat providers", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let updatedRequest: unknown;
  await page.route(
    "https://models-a2-ui-fixture.test/v1/chat/completions",
    async (route) => {
      updatedRequest = route.request().postDataJSON();
      await route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: 'data: {"choices":[{"delta":{"content":"Updated connection used."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      });
    },
  );
  await page.route("https://models-a-ui-fixture.test/v1/models", (route) =>
    route.fulfill({
      json: { data: [{ id: "local-coder" }, { id: "second-coder" }] },
    }),
  );
  await page.route("https://models-b-ui-fixture.test/v1/models", (route) =>
    route.fulfill({ json: { data: [{ id: "local-coder" }] } }),
  );
  await page.goto("/connections");
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await saveConnection(page, "Server A", "https://models-a-ui-fixture.test");
  await saveConnection(page, "Server B", "https://models-b-ui-fixture.test");
  await page.getByRole("link", { name: "Open Models", exact: true }).click();
  await expect(
    page.getByLabel("Server model local-coder", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search models", { exact: true }).fill("second");
  await expect(
    page.getByLabel("Server model local-coder", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Server model second-coder", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search models", { exact: true }).fill("");
  await page
    .getByRole("button", { name: "Select local-coder", exact: true })
    .click();
  await expect(
    page.getByText(
      "Model choice saved. Choose the saved provider in chat to use it.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Select second-coder", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Cancel model action", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel model action", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Select local-coder", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Select second-coder", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm model action", exact: true })
    .click();
  await expect(
    page.getByLabel("Server model second-coder", { exact: true }),
  ).toContainText("Selected");
  await page.reload();
  await expect(
    page.getByLabel("Server model second-coder", { exact: true }),
  ).toContainText("Selected");
  await page
    .getByRole("button", { name: "Use model server Server B", exact: true })
    .click();
  await expect(
    page.getByText("Server: Server B", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Select local-coder", exact: true })
    .click();
  await expect(
    page.getByLabel("Server model local-coder", { exact: true }),
  ).toContainText("Selected");
  await page.reload();
  await expect(
    page.getByText("Server: Server B", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Server model local-coder", { exact: true }),
  ).toContainText("Selected");
  await page
    .getByRole("button", { name: "Use model server Server A", exact: true })
    .click();
  await expect(
    page.getByLabel("Server model second-coder", { exact: true }),
  ).toContainText("Selected");
  await expect(
    page.getByText("Available on server · Selected", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/models-selection-durable.png`,
    fullPage: true,
  });
  await openChat(page);
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Server A.*second-coder/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Server B.*local-coder/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Server A.*second-coder/ }).click();
  await expect(
    page.getByText("Server A - second-coder", { exact: true }),
  ).toBeVisible();
  await page.goto("/connections");
  await page
    .getByRole("button", { name: "Edit Server A", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Connection name", exact: true })
    .fill("Renamed A");
  await page
    .getByRole("textbox", { name: "Server host", exact: true })
    .fill("https://models-a2-ui-fixture.test");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit Renamed A", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to chat", exact: true }).click();
  await expect(
    page.getByText("Renamed A - second-coder", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Check the updated endpoint");
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Updated connection used.", { exact: true }),
  ).toBeVisible();
  expect(updatedRequest).toMatchObject({ model: "second-coder" });
  await page.goto("/connections");
  await page
    .getByRole("button", { name: "Delete Renamed A", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit Renamed A", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Back to chat", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "LocalLab Chat", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Renamed A - second-coder", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Renamed A.*second-coder/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Server B.*local-coder/ }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("library folders, saved message search, reopening and delete confirmation persist", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(
    "https://library-ui-fixture.test/v1/responses",
    async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Coffee answer saved for library search."}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":6}}}\n\n',
      });
    },
  );
  await openChat(page);
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await page
    .getByRole("button", { name: "Set up OpenAI", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Responses endpoint URL", exact: true })
    .fill("https://library-ui-fixture.test/v1/responses");
  await page
    .getByRole("textbox", { name: "OpenAI model ID", exact: true })
    .fill("library-fixture");
  await page
    .getByLabel("OpenAI API key", { exact: true })
    .fill("test-key-no-external-network");
  await page
    .getByRole("button", {
      name: "Save OpenAI endpoint and model",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Coffee question for durable library search");
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Coffee answer saved for library search.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByLabel("Search conversations", { exact: true }).fill("coffee");
  await expect(
    page.getByText("Coffee question for durable library search", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Search conversations", { exact: true }).fill("");
  await page
    .getByRole("textbox", { name: "New folder name", exact: true })
    .fill("Research");
  await page
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Open folder Research(?:, selected)?$/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "All conversations", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Conversation OpenAI chat", exact: true })
    .getByRole("button", { name: "Move to Research", exact: true })
    .click();
  await page
    .getByRole("button", { name: /^Open folder Research(?:, selected)?$/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove from folder", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Rename Research", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Folder name", exact: true })
    .fill("Notes");
  await page
    .getByRole("button", { name: "Save folder name", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Open folder Notes(?:, selected)?$/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Set Notes color #006A6A", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Folder Notes", exact: true }),
  ).toHaveCSS("border-left-color", "rgb(0, 106, 106)");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "LocalLab Chat", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .getByRole("button", { name: /^Open folder Notes(?:, selected)?$/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove from folder", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Folder Notes", exact: true }),
  ).toHaveCSS("border-left-color", "rgb(0, 106, 106)");
  await page.getByRole("button", { name: "Delete Notes", exact: true }).click();
  await page
    .getByRole("button", { name: "Cancel folder deletion", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Open folder Notes(?:, selected)?$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete Notes", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm delete folder", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Open folder Notes(?:, selected)?$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open OpenAI chat", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open OpenAI chat", exact: true })
    .click();
  await expect(
    page.getByText("Coffee answer saved for library search.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Semantic", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Search saved conversations", { exact: true })
    .fill("coffee");
  await expect(
    page.getByRole("button", {
      name: "Open OpenAI chat, user message",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open OpenAI chat, assistant message",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Open OpenAI chat, assistant message",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Coffee answer saved for library search.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Coffee answer saved for library search.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^Open folder Notes(?:, selected)?$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open OpenAI chat", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/library-durable.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Ollama lifecycle controls cancel pending pulls and confirm server deletion", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let installed = true;
  let deletes = 0;
  let pullBody: unknown;
  let releasePull!: () => void;
  const heldPull = new Promise<void>((resolve) => {
    releasePull = resolve;
  });
  await page.route("https://ollama-ui-fixture.test/api/tags", (route) =>
    route.fulfill({
      json: {
        models: installed ? [{ name: "fixture:latest", size: 1024 }] : [],
      },
    }),
  );
  await page.route("https://ollama-ui-fixture.test/api/ps", (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.route(
    "https://ollama-ui-fixture.test/api/delete",
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        model: "fixture:latest",
      });
      deletes++;
      installed = false;
      await route.fulfill({ status: 200, body: "" });
    },
  );
  await page.route("https://ollama-ui-fixture.test/api/pull", async (route) => {
    pullBody = route.request().postDataJSON();
    await heldPull;
    await route
      .fulfill({
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
        body: '{"status":"success"}\n',
      })
      .catch(() => undefined);
  });
  try {
    await page.goto("/connections");
    await expect(
      page.getByRole("heading", { name: "Connections", exact: true }),
    ).toBeVisible();
    await saveConnection(
      page,
      "Ollama fixture",
      "https://ollama-ui-fixture.test",
      "ollama",
    );
    await page.getByRole("link", { name: "Open Models", exact: true }).click();
    await expect(
      page.getByLabel("Server model fixture:latest", { exact: true }),
    ).toContainText("Downloaded");
    await page
      .getByRole("button", { name: "Delete fixture:latest", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Cancel model action", exact: true })
      .click();
    expect(deletes).toBe(0);
    await page
      .getByRole("button", { name: "Delete fixture:latest", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm model action", exact: true })
      .click();
    await expect(
      page.getByLabel("Server model fixture:latest", { exact: true }),
    ).toHaveCount(0);
    expect(deletes).toBe(1);
    await page
      .getByRole("textbox", {
        name: "Exact Ollama model ID to download",
        exact: true,
      })
      .fill("new-fixture:exact-tag");
    await page
      .getByRole("button", { name: "Download exact Ollama model", exact: true })
      .click();
    await expect
      .poll(() => pullBody)
      .toEqual({ model: "new-fixture:exact-tag", stream: true });
    await expect(
      page.getByRole("button", { name: "Cancel download", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Cancel download", exact: true })
      .click();
    await expect(
      page.getByText("Download canceled.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Download exact Ollama model",
        exact: true,
      }),
    ).toBeEnabled();
    await page.screenshot({
      path: `${testInfo.outputDir}/ollama-cancel-delete.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    releasePull();
  }
});
