import { expect, test, type Page } from "@playwright/test";

test.use({ actionTimeout: 10_000 });

async function openChat(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to LocalLab" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page.getByRole("button", { name: /^Choose dark theme/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "LocalLab Chat", exact: true }),
  ).toBeVisible();
}

test("Persona profiles can be created, edited, selected, launched and deleted", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openChat(page);
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  await expect(
    page.getByLabel("Persona profile Default", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete Default", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add Default to a group", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByText("Group chats are not available in this build.", {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/personas-dark-initial.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create Persona", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save Persona profile" }),
  ).toBeDisabled();
  await testInfo.attach("persona-editor-dom", {
    body: await page.locator("body").ariaSnapshot(),
    contentType: "text/plain",
  });
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Browser Helper");
  await page
    .getByRole("textbox", { name: "About this Persona", exact: true })
    .fill("Created through the rendered Persona editor.");
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("Answer briefly and use plain words.");
  await page
    .getByRole("textbox", { name: "Accent color", exact: true })
    .fill("#356A58");
  await page
    .getByRole("textbox", { name: "Profile background color", exact: true })
    .fill("#EAF2F0");
  await page.getByRole("radio", { name: /^Square avatar/ }).click();
  await page
    .getByRole("button", { name: "Save Persona profile", exact: true })
    .click();
  await expect(
    page.getByLabel("Persona profile Browser Helper", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Edit profile for Browser Helper",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Browser Helper");
  await expect(
    page.getByRole("textbox", { name: "System prompt", exact: true }),
  ).toHaveValue("Answer briefly and use plain words.");
  await expect(
    page.getByRole("radio", { name: /^Square avatar/ }),
  ).toHaveAttribute("aria-label", "Square avatar, selected");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Discarded edit");
  await page
    .getByRole("button", {
      name: "Cancel Persona profile editing",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Persona profile Browser Helper", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Use Browser Helper in current chat",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Persona: Browser Helper", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Persona", exact: true }),
  ).toBeEnabled();
  await page.getByRole("tab", { name: "Persona", exact: true }).click();
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("Use the Browser Helper Persona settings.");
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Edit profile for Browser Helper",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Renamed Browser Helper");
  await page
    .getByRole("button", { name: "Save Persona profile", exact: true })
    .click();
  await expect(
    page.getByText("Persona: Renamed Browser Helper", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Persona profile Renamed Browser Helper", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Edit profile for Renamed Browser Helper",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Browser Helper");
  await page
    .getByRole("button", { name: "Save Persona profile", exact: true })
    .click();
  await expect(
    page.getByText("Persona: Browser Helper", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close Persona library", exact: true })
    .click();
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Start chat with Browser Helper",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Persona profile Browser Helper", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Persona: Browser Helper", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "LocalLab Chat", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  await expect(
    page.getByLabel("Persona profile Browser Helper", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete Browser Helper", exact: true })
    .click();
  await expect(
    page.getByText("Delete Browser Helper?", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel Persona deletion", exact: true })
    .click();
  await expect(
    page.getByLabel("Persona profile Browser Helper", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete Browser Helper", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm Persona deletion", exact: true })
    .click();
  await expect(
    page.getByLabel("Persona profile Browser Helper", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Persona: Default", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Use Default in current chat",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Close Persona library", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Persona", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Default uses global and model settings. Select a custom Persona to edit Persona settings.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "System prompt", exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete LocalLab assistant", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm Persona deletion", exact: true })
    .click();
  await expect(
    page.getByLabel("Persona profile LocalLab assistant", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  await expect(
    page.getByLabel("Persona profile LocalLab assistant", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Persona profile Default", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/personas-after-durable-deletion.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Memory consent, manual facts, search, edit and deletion persist", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openChat(page);
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const extraction = page.getByRole("switch", {
    name: "Extract memory after completed replies",
    exact: true,
  });
  const injection = page.getByRole("switch", {
    name: "Use saved facts in future prompts",
    exact: true,
  });
  await expect(extraction).not.toBeChecked();
  await expect(injection).not.toBeChecked();
  await extraction.click();
  await expect(extraction).toBeChecked();
  await injection.click();
  await expect(injection).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Save memory fact", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "New memory fact", exact: true })
    .fill("My browser exercise project is called Cedar.");
  await page
    .getByRole("button", { name: "Save memory fact", exact: true })
    .click();
  await expect(
    page.getByText("My browser exercise project is called Cedar.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Search saved memory", { exact: true })
    .fill("missing-needle");
  await expect(
    page.getByText("No saved facts match your search.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search saved memory", { exact: true }).fill("Cedar");
  await page
    .getByRole("button", { name: "Edit saved memory", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Edit saved memory fact", exact: true })
    .fill("Discard this memory edit.");
  await page
    .getByRole("button", { name: "Cancel memory edit", exact: true })
    .click();
  await expect(
    page.getByText("My browser exercise project is called Cedar.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit saved memory", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Edit saved memory fact", exact: true })
    .fill("My browser exercise project Cedar uses SQLite.");
  await page
    .getByRole("button", { name: "Save memory edit", exact: true })
    .click();
  await expect(
    page.getByText("My browser exercise project Cedar uses SQLite.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Across conversations / Edited by you", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(extraction).toBeChecked();
  await expect(injection).toBeChecked();
  await expect(
    page.getByText("My browser exercise project Cedar uses SQLite.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete saved memory", exact: true })
    .click();
  await expect(
    page.getByText("Delete saved memory?", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel memory deletion", exact: true })
    .click();
  await expect(
    page.getByText("My browser exercise project Cedar uses SQLite.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete saved memory", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm memory deletion", exact: true })
    .click();
  await expect(page.getByText("Memory deleted", { exact: true })).toBeVisible();
  await expect(
    page.getByText("No saved memory yet.", { exact: true }),
  ).toBeVisible();
  await extraction.click();
  await expect(extraction).not.toBeChecked();
  await injection.click();
  await expect(injection).not.toBeChecked();
  await page.reload();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(extraction).not.toBeChecked();
  await expect(injection).not.toBeChecked();
  await expect(
    page.getByText("No saved memory yet.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/memory-consent-and-durable-deletion.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Settings scopes, parameter reset, appearance and context actions are rendered", async ({
  page,
}, testInfo) => {
  await openChat(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Chat and model settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Persona", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Default uses global and model settings. Select a custom Persona to edit Persona settings.",
      { exact: true },
    ),
  ).toBeVisible();
  const prompt = page.getByRole("textbox", {
    name: "System prompt",
    exact: true,
  });
  const context = page.getByRole("textbox", {
    name: "Context window",
    exact: true,
  });
  const globalPrompt = "Global browser exercise prompt.\nKeep replies useful.";
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await prompt.fill(globalPrompt);
  await expect(prompt).toHaveValue(globalPrompt);
  await context.fill("4096");
  await expect(context).toHaveValue("4096");
  await page.getByRole("tab", { name: "This chat", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "This chat", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(prompt).toHaveValue(globalPrompt);
  await expect(context).toHaveValue("4096");
  await prompt.fill("Conversation browser exercise prompt.");
  await context.fill("2048");
  await page
    .getByRole("heading", { name: "Chat and model settings", exact: true })
    .click();
  await testInfo.attach("settings-before-reset", {
    body: await page.locator("body").ariaSnapshot(),
    contentType: "text/plain",
  });
  const contextCard = page
    .locator("div")
    .filter({ has: context })
    .filter({ has: page.getByText("Context window", { exact: true }) })
    .last();
  await contextCard.getByRole("button", { name: /Reset this value$/ }).click();
  await expect(context).toHaveValue("4096");
  await page
    .getByRole("textbox", {
      name: "Chat avatar initials",
      exact: true,
    })
    .fill("CH");
  await page
    .getByRole("button", { name: "Background #EAF2F0", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reload context", exact: true })
    .click();
  await expect(
    page
      .getByText("Saved context settings will apply to your next message.", {
        exact: true,
      })
      .last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cut middle", exact: true }).click();
  await page
    .getByRole("button", { name: "Save context policy", exact: true })
    .click();
  await expect(
    page
      .getByText("Context packing policy saved for the next message.", {
        exact: true,
      })
      .last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByLabel("Conversation avatar CH", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Cut middle", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Summarize", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Summary compaction is not available in this build.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/settings-scopes-and-context.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByLabel("Conversation avatar CH", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Cut middle", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(prompt).toHaveValue("Conversation browser exercise prompt.");
  await expect(context).toHaveValue("4096");
  await expect(
    page.getByRole("textbox", {
      name: "Chat avatar initials",
      exact: true,
    }),
  ).toHaveValue("CH");
  await expect(
    page.getByLabel("Conversation avatar CH", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await expect(prompt).toHaveValue(globalPrompt);
  await page.getByRole("tab", { name: "This chat", exact: true }).click();
  const promptCard = page
    .locator("div")
    .filter({ has: prompt })
    .filter({ has: page.getByText("System prompt", { exact: true }) })
    .last();
  await promptCard.getByRole("button", { name: /Reset this value$/ }).click();
  await expect(prompt).toHaveValue(globalPrompt);
});

test("Persona avatar uses real file intake, survives reload, and can be removed", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openChat(page);
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  await page
    .getByRole("button", { name: "Create Persona", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Avatar Helper");
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Choose Persona avatar", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB5kAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(
    page.getByRole("img", { name: "Avatar Helper avatar", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save Persona profile", exact: true })
    .click();
  await expect(
    page.getByLabel("Persona profile Avatar Helper", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Avatar Helper avatar", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  const avatar = page.getByRole("img", {
    name: "Avatar Helper avatar",
    exact: true,
  });
  await expect(avatar).toBeVisible();
  await expect
    .poll(() =>
      avatar.evaluate((element) => {
        const image = element.matches("img")
          ? (element as HTMLImageElement)
          : element.querySelector("img");
        return !!image && image.complete && image.naturalWidth > 0;
      }),
    )
    .toBe(true);
  await avatar.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${testInfo.outputDir}/persona-avatar-reloaded.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: "Edit profile for Avatar Helper",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Remove Persona avatar", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "About this Persona", exact: true })
    .fill("Avatar removed through the editor.");
  await page
    .getByRole("button", { name: "Save Persona profile", exact: true })
    .click();
  await expect(avatar).toHaveCount(0);
  await expect(
    page.getByText("Avatar removed through the editor.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  await expect(avatar).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Edit profile for Avatar Helper",
      exact: true,
    })
    .click();
  const invalidChooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Choose Persona avatar", exact: true })
    .click();
  await (
    await invalidChooser
  ).setFiles({
    name: "not-an-image.html",
    mimeType: "text/html",
    buffer: Buffer.from("<p>Not an avatar</p>"),
  });
  await expect(page.getByRole("alert")).toContainText(
    "Choose a JPEG, PNG, WebP, HEIC, or HEIF image",
  );
  await expect(
    page.getByRole("button", { name: "Remove Persona avatar", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Cancel Persona profile editing",
      exact: true,
    })
    .click();
  expect(errors).toEqual([]);
});

test("Settings permit normal digit typing without rewriting partial input", async ({
  page,
}, testInfo) => {
  await openChat(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const context = page.getByRole("textbox", {
    name: "Context window",
    exact: true,
  });
  await context.fill("");
  await context.pressSequentially("2048", { delay: 50 });
  await expect(context).toHaveValue("2048");
  await page
    .getByRole("heading", { name: "Chat and model settings", exact: true })
    .click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(context).toHaveValue("2048");
  await expect(
    page.getByRole("textbox", { name: "Temperature", exact: true }),
  ).not.toBeEditable();
  for (const label of [
    "Top P",
    "Top K",
    "Min P",
    "Repeat penalty",
    "Maximum output tokens",
    "GPU layers",
  ]) {
    await expect(
      page.getByRole("textbox", { name: label, exact: true }),
    ).not.toBeEditable();
  }
  for (const label of [
    "Reasoning",
    "JSON / structured output",
    "Flash attention",
    "KV cache offload",
    "Memory map weights",
  ]) {
    await expect(
      page.getByRole("switch", { name: label, exact: true }),
    ).toBeDisabled();
  }
  await expect(
    page.getByRole("tab", { name: "Model", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: `${testInfo.outputDir}/settings-number-typing.png`,
    fullPage: true,
  });
});

test("Real local replies preserve Persona history and extract sourced memory after consent", async ({
  page,
}, testInfo) => {
  const apiBase = process.env.LOCALLAB_LIVE_API_BASE;
  const model = process.env.LOCALLAB_LIVE_MODEL ?? "local-coder";
  test.skip(
    !apiBase,
    "Set LOCALLAB_LIVE_API_BASE to exercise real generation and extraction.",
  );
  test.setTimeout(240_000);
  const errors: string[] = [];
  const requests: Array<{
    target: string;
    body: {
      model: string;
      messages: Array<{ role: string; content: unknown }>;
      max_tokens?: number;
    };
    extraction: boolean;
  }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const providerTarget = (url: string) => {
    const parsed = new URL(url);
    return parsed.pathname === "/_locallab/provider"
      ? parsed.searchParams.get("url")
      : url;
  };
  page.on("request", (request) => {
    const target = providerTarget(request.url());
    if (request.method() !== "POST" || !target?.endsWith("/chat/completions"))
      return;
    const body = request.postDataJSON();
    const extraction = body.messages?.some(
      (message: { role: string; content: unknown }) =>
        message.role === "system" &&
        String(message.content).includes("Extract durable candidate facts"),
    );
    requests.push({ target, body, extraction });
  });
  await openChat(page);
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("tab", { name: "compatible", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Supporting flow local server");
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
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(
    page.getByText(`Connected: ${model} is available.`, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save and use provider", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("<|think_off|>\nReply with one brief sentence.");
  await page
    .getByRole("textbox", { name: "Maximum output tokens", exact: true })
    .fill("768");
  await page
    .getByRole("textbox", { name: "Context window", exact: true })
    .fill("16384");
  await page.getByRole("tab", { name: "Model", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Maximum output tokens", exact: true }),
  ).toHaveValue("768");
  await page
    .getByRole("textbox", { name: "Maximum output tokens", exact: true })
    .fill("640");
  await page
    .getByRole("heading", { name: "Chat and model settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use Global params", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Maximum output tokens", exact: true }),
  ).toHaveValue("768");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const manualFact = "My preferred orchard fruit is persimmon.";
  await page
    .getByRole("textbox", { name: "New memory fact", exact: true })
    .fill(manualFact);
  await page
    .getByRole("button", { name: "Save memory fact", exact: true })
    .click();
  await expect(page.getByText(manualFact, { exact: true })).toBeVisible();
  await page
    .getByRole("switch", {
      name: "Use saved facts in future prompts",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("switch", {
      name: "Use saved facts in future prompts",
      exact: true,
    }),
  ).toBeChecked();
  await page
    .getByRole("switch", {
      name: "Extract memory after completed replies",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("switch", {
      name: "Extract memory after completed replies",
      exact: true,
    }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Close memory", exact: true }).click();
  const firstMessage =
    "My preferred code editor is Helix. Acknowledge this durable preference in one brief sentence.";
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(firstMessage);
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  const firstChat = requests.find((request) => !request.extraction)!;
  expect(firstChat.target).toBe(
    `${apiBase!.replace(/\/$/, "")}/chat/completions`,
  );
  expect(firstChat.body.model).toBe(model);
  expect(firstChat.body.max_tokens).toBe(768);
  expect(
    firstChat.body.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n"),
  ).toContain(manualFact);
  expect(
    firstChat.body.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n"),
  ).toContain("<|think_off|>\nReply with one brief sentence.");
  await testInfo.attach("first-live-request-settings-and-memory", {
    body: JSON.stringify(firstChat, null, 2),
    contentType: "application/json",
  });
  await expect(page.getByTestId("assistant-response-text")).toContainText(
    "Helix",
  );
  await expect
    .poll(() => requests.filter((request) => request.extraction).length, {
      timeout: 30_000,
    })
    .toBe(1);
  const extractionRequest = requests.find((request) => request.extraction)!;
  const extractionSystem = extractionRequest.body.messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content))
    .join("\n");
  expect(extractionSystem).toMatch(
    /^<\|think_off\|>\s+Extract durable candidate facts/,
  );
  expect(extractionSystem).toContain("Return only JSON with this shape:");
  expect(extractionSystem).not.toContain("Reply with one brief sentence.");
  expect(extractionRequest.body.max_tokens).toBe(2_048);
  await testInfo.attach("live-extraction-request-model-control-and-schema", {
    body: JSON.stringify(extractionRequest, null, 2),
    contentType: "application/json",
  });
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect
    .poll(
      async () => {
        await page
          .getByRole("button", { name: "Refresh saved memory", exact: true })
          .click();
        return page
          .getByText("Across conversations / Extracted from a completed turn", {
            exact: true,
          })
          .count();
      },
      { timeout: 60_000, intervals: [250, 500, 1000] },
    )
    .toBeGreaterThan(0);
  const extracted = page
    .getByLabel("Saved memory entry", { exact: true })
    .filter({ hasText: "Helix" });
  await expect(extracted).toHaveCount(1);
  const sourceQuote = extracted.getByText(/Source quote:.*Helix/);
  await sourceQuote.scrollIntoViewIfNeeded();
  await expect(sourceQuote).toBeInViewport();
  await page.screenshot({
    path: `${testInfo.outputDir}/live-extracted-memory-with-source.png`,
    fullPage: true,
  });
  await extracted
    .getByRole("button", { name: "Open source message", exact: true })
    .click();
  await expect(page.getByText(firstMessage, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page
    .getByRole("switch", {
      name: "Extract memory after completed replies",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("switch", {
      name: "Extract memory after completed replies",
      exact: true,
    }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Close memory", exact: true }).click();
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  await page
    .getByRole("button", { name: "Create Persona", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Plain Reviewer");
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill(
      "<|think_off|>\nReview using plain words and a single short sentence.",
    );
  await page
    .getByRole("button", { name: "Save Persona profile", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Use Plain Reviewer in current chat",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Persona: Plain Reviewer", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(firstMessage, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Persona", exact: true }).click();
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("Keep each reply to one sentence.");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Which editor did I say I prefer? Reply briefly.");
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toHaveCount(2, { timeout: 90_000 });
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText("Helix");
  const chats = requests.filter((request) => !request.extraction);
  expect(chats).toHaveLength(2);
  const secondSystem = chats[1]!.body.messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content))
    .join("\n");
  expect(secondSystem).toContain("Review using plain words");
  expect(secondSystem).toContain("Keep each reply to one sentence.");
  expect(secondSystem).not.toContain(manualFact);
  expect(chats[1]!.body.messages).toContainEqual({
    role: "user",
    content: firstMessage,
  });
  expect(requests.filter((request) => request.extraction)).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByText("Persona: Plain Reviewer", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(firstMessage, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toHaveCount(2);
  await page.screenshot({
    path: `${testInfo.outputDir}/live-persona-switch-preserved-transcript.png`,
    fullPage: true,
  });
  await testInfo.attach("live-memory-and-persona-requests", {
    body: JSON.stringify(requests, null, 2),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
});
