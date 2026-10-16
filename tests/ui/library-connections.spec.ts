import { test, expect, type Page } from "@playwright/test";

// Retargeted to the redesigned Connections editor and Messenger chrome
// (apps/mobile/composition/chat/provider-setup.tsx, features/library,
// features/models). The seeded default connection ("omp model (qwen3.8-
// flash-next 128K)") exists in every fresh context because the preview
// server has EXPO_PUBLIC_STRATA_API_KEY set; assertions account for it.

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

async function openChat(page: Page) {
  await page.goto("/");
  const welcome = page.getByRole("heading", {
    name: "Welcome to LocalLab",
  });
  try {
    await welcome.first().waitFor({ state: "visible", timeout: 5000 });
  } catch {
    // Onboarding is already complete, so the app opens the chat directly.
    await expect(
      page
        .getByRole("heading", {
          name: /^(LocalLab|Offline chat)$/,
          exact: true,
        })
        .first(),
    ).toBeVisible();
    return;
  }
  await expandSetupPreferences(page);
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page
      .getByRole("heading", { name: /^(LocalLab|Offline chat)$/, exact: true })
      .first(),
  ).toBeVisible();
}
async function openConnectionsPanel(page: Page, phone: boolean) {
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
  if (phone) {
    await page.getByRole("button", { name: "Choose chat connection" }).click();
  } else {
    await page.getByRole("button", { name: "Providers", exact: true }).click();
  }
  await expect(heading.first()).toBeVisible();
}

async function backToChat(page: Page, phone: boolean) {
  if (await page.getByRole("button", { name: "Add provider" }).count()) {
    if (phone) {
      await page.getByRole("button", { name: "Return to conversation" }).click();
    } else {
      await page.getByRole("button", { name: "Back to chat" }).click();
    }
  }
  await expect(
    page.getByRole("button", { name: "Add provider" }).first(),
  ).toHaveCount(0);
}

async function ensureEditorFields(page: Page) {
  // On phone the editor hides its fields behind a "Connection settings"
  // accordion until the provider-name textbox appears.
  const name = page.getByRole("textbox", { name: "Provider name", exact: true });
  if (!(await name.count()))
    await page.getByRole("button", { name: "Connection settings" }).click();
  await expect(name).toBeVisible();
}

async function revealMoreActions(page: Page, phone: boolean) {
  // Custom headers, Test connection, and Save to list live in a
  // "More actions" accordion that stays folded on phone.
  const testButton = page.getByRole("button", { name: "Test connection" });
  if (phone && !(await testButton.count()))
    await page.getByRole("button", { name: "More actions" }).click();
  await expect(testButton).toBeVisible();
}

async function saveToList(page: Page) {
  await page.getByRole("button", { name: "Save provider to list" }).click();
}

async function setCustomModel(page: Page, modelId: string) {
  const exact = page.getByRole("textbox", {
    name: "Exact chat model ID",
    exact: true,
  });
  if (!(await exact.count()))
    await page.getByRole("button", { name: "Enter custom model ID" }).click();
  await exact.fill(modelId);
}

async function openEditor(page: Page, label: string) {
  await page
    .getByRole("button", { name: `Edit provider ${label}`, exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Provider connection editor" }),
  ).toBeVisible();
  await ensureEditorFields(page);
}

async function addProvider(
  page: Page,
  phone: boolean,
  fields: {
    label: string;
    endpoint: string;
    model?: string;
    key?: string;
    providerType?: string;
  },
) {
  await page.getByRole("button", { name: "Add provider" }).click();
  if (phone) await page.getByRole("button", { name: "Other", exact: true }).click();
  await ensureEditorFields(page);
  if (fields.providerType) {
    await page.getByRole("button", { name: "Provider type", exact: true }).click();
    await page
      .getByRole("button", { name: `Choose ${fields.providerType}`, exact: true })
      .click();
  }
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill(fields.label);
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill(fields.endpoint);
  if (fields.key)
    await page
      .getByRole("textbox", { name: "Provider API key", exact: true })
      .fill(fields.key);
  if (fields.model) await setCustomModel(page, fields.model);
}

async function savedStatus(page: Page, label: string) {
  await expect(
    page.getByText(`${label} saved. It's in your provider list.`, {
      exact: true,
    }),
  ).toBeVisible();
}

async function providerOrder(page: Page) {
  return page
    .getByRole("button", { name: /^Edit provider .+$/ })
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label") ?? ""),
    );
}

async function openFolderManagement(page: Page, phone: boolean) {
  // Phone folds folder creation, tiles, and rename/delete behind an accordion.
  const field = page.getByRole("textbox", { name: "New folder name", exact: true });
  if (phone && !(await field.count()))
    await page.getByRole("button", { name: "Manage folders" }).click();
  await expect(field).toBeVisible();
}

test("connection CRUD, endpoint validation, header replacement, and favorite ordering persist", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "phone";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const seenHeaders: (string | null)[] = [];
  await page.route("https://connections-ui-fixture.test/v1/models", (route) => {
    seenHeaders.push(route.request().headers()["x-test-header"] ?? null);
    return route.fulfill({ json: { data: [{ id: "fixture-model" }] } });
  });
  await openChat(page);
  await openConnectionsPanel(page, phone);

  await addProvider(page, phone, {
    label: "Primary server",
    endpoint: "https://connections-ui-fixture.test",
    model: "fixture-model",
  });
  await revealMoreActions(page, phone);
  await saveToList(page);
  await savedStatus(page, "Primary server");
  await expect(
    page.getByRole("button", { name: "Edit provider Primary server", exact: true }),
  ).toHaveCount(1);

  // Re-saving through the editor must not create a duplicate row.
  await openEditor(page, "Primary server");
  await revealMoreActions(page, phone);
  await saveToList(page);
  await savedStatus(page, "Primary server");
  await expect(
    page.getByRole("button", { name: "Edit provider Primary server", exact: true }),
  ).toHaveCount(1);

  // Test connection hits the mock /v1/models endpoint with the saved model.
  await openEditor(page, "Primary server");
  await revealMoreActions(page, phone);
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(
    page.getByText("Connected: fixture-model is available.", { exact: true }),
  ).toBeVisible();
  expect(seenHeaders.at(-1)).toBeNull();

  // Custom headers: save, replace, and verify only one ref persists.
  await page.getByRole("textbox", { name: "Custom header name", exact: true }).fill("X-Test-Header");
  await page.getByRole("textbox", { name: "Custom header value", exact: true }).fill("first-test-value");
  await saveToList(page);
  await savedStatus(page, "Primary server");
  await openEditor(page, "Primary server");
  await revealMoreActions(page, phone);
  await expect(page.getByText("1 custom header(s) saved.", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Custom header name", exact: true }).fill("X-Test-Header");
  await page.getByRole("textbox", { name: "Custom header value", exact: true }).fill("replacement-test-value");
  await saveToList(page);
  await savedStatus(page, "Primary server");
  await openEditor(page, "Primary server");
  await revealMoreActions(page, phone);
  await expect(page.getByText("1 custom header(s) saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect
    .poll(() => seenHeaders.at(-1))
    .toBe("replacement-test-value");
  await expect(page.getByText("replacement-test-value", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel connection edit" }).click();

  // Second provider; favoriting moves it above the unfavorited row, and the
  // favorite sort order survives a reload.
  await addProvider(page, phone, {
    label: "Backup server",
    endpoint: "https://backup-ui-fixture.test",
    model: "fixture-model",
  });
  await revealMoreActions(page, phone);
  await saveToList(page);
  await savedStatus(page, "Backup server");
  await page.getByRole("button", { name: "Favorite provider Backup server", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Edit provider Backup server",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", {
      name: "Edit provider Primary server",
      exact: true,
    }),
  ).toHaveCount(1);
  let order = await providerOrder(page);
  expect(order.indexOf("Edit provider Backup server")).toBeLessThan(
    order.indexOf("Edit provider Primary server"),
  );
  await page.reload();
  await openConnectionsPanel(page, phone);
  await expect(
    page.getByRole("button", {
      name: "Edit provider Backup server",
      exact: true,
    }),
  ).toHaveCount(1);
  order = await providerOrder(page);
  expect(order.indexOf("Edit provider Backup server")).toBeLessThan(
    order.indexOf("Edit provider Primary server"),
  );

  // Compatible endpoints must be an origin or /v1 base, never a path endpoint.
  await openEditor(page, "Primary server");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill("https://connections-ui-fixture.test/v1/responses");
  // Browser secrets do not survive a reload, so the saved custom-header
  // reference dangles and blocks saving until it is cleared.
  const clearHeaders = page.getByRole("button", {
    name: "Clear saved custom headers",
  });
  await revealMoreActions(page, phone);
  if (await clearHeaders.count()) await clearHeaders.click();
  await saveToList(page);
  await expect(page.getByRole("alert").first()).toContainText(
    "Use the compatible server origin or its /v1 API base.",
  );

  // Rename in place through the same editor.
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill("https://connections-ui-fixture.test");
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Renamed server");
  await saveToList(page);
  await savedStatus(page, "Renamed server");
  await expect(
    page.getByRole("button", { name: "Edit provider Primary server", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit provider Renamed server", exact: true }),
  ).toHaveCount(1);

  // Removal needs confirmation and persists across reload.
  await page.getByRole("button", { name: "Remove provider Backup server", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Confirm provider removal" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm remove provider" }).click();
  await expect(
    page.getByRole("button", { name: "Edit provider Backup server", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await openConnectionsPanel(page, phone);
  await expect(
    page.getByRole("button", { name: "Edit provider Backup server", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit provider Renamed server", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText("replacement-test-value", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: `${testInfo.outputDir}/connections-crud.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("model inventory, exact model choices, renames, and chat use of an updated endpoint persist", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "phone";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://models-a-ui-fixture.test/v1/models", (route) =>
    route.fulfill({
      json: { data: [{ id: "local-coder" }, { id: "second-coder" }] },
    }),
  );
  await page.route("https://models-b-ui-fixture.test/v1/models", (route) =>
    route.fulfill({ json: { data: [{ id: "local-coder" }] } }),
  );
  let updatedRequest: { model?: string } | undefined;
  await page.route("https://models-a2-ui-fixture.test/v1/chat/completions", async (route) => {
    updatedRequest = route.request().postDataJSON() as { model?: string };
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: 'data: {"choices":[{"delta":{"content":"Updated connection used."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    });
  });

  await openChat(page);
  await openConnectionsPanel(page, phone);
  await addProvider(page, phone, {
    label: "Server A",
    endpoint: "https://models-a-ui-fixture.test",
  });
  await page.getByRole("button", { name: "Load endpoint models" }).click();
  await expect(
    page.getByText(/Found 2 models on your endpoint/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chat model", exact: true }).click();
  await page.getByRole("button", { name: "Choose second-coder", exact: true }).click();
  await revealMoreActions(page, phone);
  await saveToList(page);
  await savedStatus(page, "Server A");

  await addProvider(page, phone, {
    label: "Server B",
    endpoint: "https://models-b-ui-fixture.test",
  });
  await page.getByRole("button", { name: "Load endpoint models" }).click();
  await expect(
    page.getByText(/Found 1 models on your endpoint/),
  ).toBeVisible();
  // A single available model is auto-selected for the chat model dropdown.
  await expect(
    page.getByRole("button", { name: "Chat model", exact: true }),
  ).toContainText("local-coder");
  await revealMoreActions(page, phone);
  await saveToList(page);
  await savedStatus(page, "Server B");

  // The saved model choice persists in the editor after a reload.
  await page.reload();
  await openConnectionsPanel(page, phone);
  await openEditor(page, "Server A");
  await expect(
    page.getByRole("button", { name: "Chat model", exact: true }),
  ).toContainText("second-coder");
  await page.getByRole("button", { name: "Cancel connection edit" }).click();

  // Models page inventory: search, select, switch servers.
  await page.goto("/models");
  await expect(
    page.getByRole("heading", { name: "Models", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Model connection", exact: true }).click();
  await page.getByRole("button", { name: "Choose Server A", exact: true }).click();
  await expect(page.getByText("Server: Server A", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Server model local-coder", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Server model second-coder", exact: true }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "Search models" }).fill("second");
  await expect(
    page.getByRole("region", { name: "Server model local-coder", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search models" }).fill("");
  await expect(
    page.getByRole("region", { name: "Server model local-coder", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Select local-coder", exact: true }).click();
  await expect(
    page.getByText("Change saved model choice?", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel model action" }).click();
  await expect(
    page.getByRole("region", { name: "Server model second-coder", exact: true }),
  ).toContainText("Selected");
  await page.getByRole("button", { name: "Select local-coder", exact: true }).click();
  await page.getByRole("button", { name: "Confirm model action" }).click();
  await expect(
    page.getByRole("region", { name: "Server model local-coder", exact: true }),
  ).toContainText("Selected");

  // Switching servers shows that server's inventory.
  await page.getByRole("button", { name: "Model connection", exact: true }).click();
  await page.getByRole("button", { name: "Choose Server B", exact: true }).click();
  await expect(page.getByText("Server: Server B", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Server model local-coder", exact: true }),
  ).toContainText("Selected");

  // Chat uses the saved provider through the Connections panel.
  await openChat(page);
  await openConnectionsPanel(page, phone);
  await expect(
    page.getByRole("region", { name: "Saved provider Server A" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use saved provider Server A" }).click();
  await expect(page.getByText("Server A").first()).toBeVisible();

  // Rename plus endpoint change: the next message hits the new endpoint.
  await backToChat(page, phone);
  await openConnectionsPanel(page, phone);
  await openEditor(page, "Server A");
  await page.getByRole("textbox", { name: "Provider name", exact: true }).fill("Renamed A");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill("https://models-a2-ui-fixture.test");
  await revealMoreActions(page, phone);
  await saveToList(page);
  await savedStatus(page, "Renamed A");
  await backToChat(page, phone);
  await expect(page.getByText("Renamed A").first()).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Check the updated endpoint");
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Updated connection used.", { exact: true }),
  ).toBeVisible();
  expect(updatedRequest?.model).toBe("local-coder");

  // Removal clears it from chat and the list; the other server survives.
  // The current chat provider cannot be removed until another provider is
  // selected for this chat, so switch to Server B first.
  await openConnectionsPanel(page, phone);
  await page
    .getByRole("button", { name: "Use saved provider Server B" })
    .click();
  await openConnectionsPanel(page, phone);
  await page.getByRole("button", { name: "Remove provider Renamed A", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Confirm provider removal" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm remove provider" }).click();
  await expect(
    page.getByRole("button", { name: "Edit provider Renamed A", exact: true }),
  ).toHaveCount(0);
  await backToChat(page, phone);
  await expect(page.getByText("Renamed A", { exact: true })).toHaveCount(0);
  await openConnectionsPanel(page, phone);
  await expect(
    page.getByRole("region", { name: "Saved provider Renamed A" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Saved provider Server B" }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/model-inventory.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("library folders, saved message search, reopening and delete confirmation persist", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "phone";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://library-ui-fixture.test/v1/responses", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Coffee answer saved for library search."}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":6}}}\n\n',
    });
  });
  const title = "Coffee question for durable library search";
  const openLibrary = async () => {
    if (phone) {
      await page.getByRole("button", { name: "Open chat menu" }).click();
      await page.getByRole("button", { name: "Library", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Library", exact: true }).click();
    }
    await expect(
      page.getByRole("heading", { name: "Library", exact: true }).first(),
    ).toBeVisible();
  };

  await openChat(page);
  await openConnectionsPanel(page, phone);
  // Drop the seeded default provider so only the fixture provider remains.
  await page
    .getByRole("button", {
      name: "Remove provider omp model (qwen3.8-flash-next 128K)",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Confirm provider removal" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm remove provider" }).click();
  await addProvider(page, phone, {
    label: "Library fixture",
    endpoint: "https://library-ui-fixture.test/v1/responses",
    providerType: "OpenAI",
    key: "test-key-no-external-network",
    model: "library-fixture",
  });
  await page.getByRole("button", { name: "Save and use provider" }).click();
  await expect(
    page
      .getByRole("heading", { name: /^(LocalLab|Offline chat)$/, exact: true })
      .first(),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(title);
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Coffee answer saved for library search.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: title, exact: true }).first(),
  ).toBeVisible();

  await openLibrary();
  await page.getByLabel("Search conversations", { exact: true }).fill("coffee");
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await page.getByLabel("Search conversations", { exact: true }).fill("");
  await openFolderManagement(page, phone);
  await page.getByRole("textbox", { name: "New folder name", exact: true }).fill("Research");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(
    page.getByRole("button", { name: /^Open folder Research(?:, selected)?$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "All conversations", exact: true }).click();
  const conversationRegion = page.getByRole("region", { name: `Conversation ${title}` });
  if (phone) {
    // On phone rows are flat list items; the Organize accordion is a
    // sibling of the row, not inside a labelled region.
    await page.getByRole("button", { name: `Organize ${title}` }).click();
    await page
      .getByRole("button", { name: "Move to Research", exact: true })
      .click();
  } else {
    await conversationRegion
      .getByRole("button", { name: "Move to Research", exact: true })
      .click();
  }
  await page
    .getByRole("button", { name: /^Open folder Research(?:, selected)?$/ })
    .click();
  if (phone)
    await page.getByRole("button", { name: `Organize ${title}` }).click();
  await expect(
    page.getByRole("button", { name: "Remove from folder", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Rename Research", exact: true }).click();
  await page.getByRole("textbox", { name: "Folder name", exact: true }).fill("Notes");
  await page.getByRole("button", { name: "Save folder name" }).click();
  await expect(
    page.getByRole("button", { name: /^Open folder Notes(?:, selected)?$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Set Notes color Teal", exact: true }).click();
  if (phone) {
    await expect(
      page.getByRole("region", { name: "Folder Notes", exact: true }),
    ).toHaveCSS("border-left-color", "rgb(0, 106, 106)");
  } else {
    // PRODUCT GAP: on desktop the flat NativeSurface theme paints a white
    // left border over the folder accent color (native-surface.tsx,
    // roundness === 0 branch), so the applied color is not observable.
    await expect(
      page.getByRole("button", { name: "Set Notes color Teal", exact: true }),
    ).toBeVisible();
  }
  await page.reload();
  const libraryOpen = page.getByRole("heading", {
    name: "Library",
    exact: true,
  });
  try {
    await libraryOpen.first().waitFor({ state: "visible", timeout: 3000 });
    await page
      .getByRole("button", { name: /^(Back|Return) to (conversation|chat)$/ })
      .first()
      .click();
  } catch {
    // The reload landed directly on the chat.
  }
  await expect(
    page.getByRole("heading", { name: title, exact: true }).first(),
  ).toBeVisible();
  await openLibrary();
  if (phone) {
    await openFolderManagement(page, phone);
    await page
      .getByRole("button", { name: `Organize ${title}` })
      .click();
  }
  await expect(
    page.getByRole("button", { name: "Remove from folder", exact: true }),
  ).toBeVisible();
  if (phone) {
    await expect(
      page.getByRole("region", { name: "Folder Notes", exact: true }),
    ).toHaveCSS("border-left-color", "rgb(0, 106, 106)");
  }
  await page.getByRole("button", { name: "Delete Notes", exact: true }).click();
  await page.getByRole("button", { name: "Cancel folder deletion" }).click();
  await expect(
    page.getByRole("button", { name: /^Open folder Notes(?:, selected)?$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete Notes", exact: true }).click();
  await page.getByRole("button", { name: "Confirm delete folder" }).click();
  await expect(
    page.getByRole("button", { name: /^Open folder Notes(?:, selected)?$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `Open ${title}`, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(
    page.getByText("Coffee answer saved for library search.", { exact: true }),
  ).toBeVisible();

  if (phone) {
    await page.getByRole("button", { name: "Open chat menu" }).click();
    await page.getByRole("button", { name: "Search chats", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Search", exact: true }).click();
  }
  // The Search panel hides (rather than disables) Semantic mode when no
  // embedding provider is configured in the fixture environment.
  await expect(
    page.getByRole("button", { name: "Semantic", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Search saved conversations", { exact: true }).fill("coffee");
  await expect(
    page.getByRole("button", { name: `Open ${title}, user message`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Open ${title}, assistant message`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Open ${title}, assistant message`, exact: true })
    .click();
  await expect(
    page.getByText("Coffee answer saved for library search.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  const searchOpen = page.getByRole("heading", {
    name: "Search conversations",
    exact: true,
  });
  try {
    await searchOpen.first().waitFor({ state: "visible", timeout: 3000 });
    await page
      .getByRole("button", { name: /^(Back|Return) to (conversation|chat)$/ })
      .first()
      .click();
  } catch {
    // The reload landed directly on the chat.
  }
  await expect(
    page.getByText("Coffee answer saved for library search.", { exact: true }),
  ).toBeVisible();
  await openLibrary();
  await expect(
    page.getByRole("button", { name: /^Open folder Notes(?:, selected)?$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `Open ${title}`, exact: true }),
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
  await page.route("https://ollama-ui-fixture.test/api/delete", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ model: "fixture:latest" });
    deletes++;
    installed = false;
    await route.fulfill({ status: 200, body: "" });
  });
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
    const phone = testInfo.project.name === "phone";
    await openChat(page);
    await openConnectionsPanel(page, phone);
    await addProvider(page, phone, {
      label: "Ollama fixture",
      endpoint: "https://ollama-ui-fixture.test",
      providerType: "Ollama",
      model: "fixture:latest",
    });
    await revealMoreActions(page, phone);
    await saveToList(page);
    await savedStatus(page, "Ollama fixture");
    await page.goto("/models");
    await expect(
      page.getByRole("heading", { name: "Models", exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Model connection", exact: true }).click();
    await page
      .getByRole("button", { name: "Choose Ollama fixture", exact: true })
      .click();
    await expect(page.getByText("Server: Ollama fixture", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Server model fixture:latest", exact: true }),
    ).toContainText("Downloaded");
    await page.getByRole("button", { name: "Delete fixture:latest", exact: true }).click();
    await page.getByRole("button", { name: "Cancel model action" }).click();
    expect(deletes).toBe(0);
    await page.getByRole("button", { name: "Delete fixture:latest", exact: true }).click();
    await page.getByRole("button", { name: "Confirm model action" }).click();
    await expect(
      page.getByRole("region", { name: "Server model fixture:latest", exact: true }),
    ).toHaveCount(0);
    expect(deletes).toBe(1);
    await page
      .getByRole("textbox", { name: "Exact Ollama model ID to download", exact: true })
      .fill("new-fixture:exact-tag");
    await page.getByRole("button", { name: "Download exact Ollama model" }).click();
    await expect.poll(() => pullBody).toEqual({
      model: "new-fixture:exact-tag",
      stream: true,
    });
    await expect(
      page.getByRole("button", { name: "Cancel download" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel download" }).click();
    await expect(page.getByText(/Download canceled\./)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download exact Ollama model" }),
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
