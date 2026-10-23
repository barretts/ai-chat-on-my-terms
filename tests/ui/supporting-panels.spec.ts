import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ actionTimeout: 10_000 });

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
  await expect(
    page.getByRole("heading", { name: "Welcome to AI Chat" }),
  ).toBeVisible();
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

/** Rail buttons toggle, and reload restores the open panel via the URL;
 * phone exposes the same items inside the chat menu with different labels. */
const panelItemNames: Record<string, RegExp> = {
  Archives: /^(Archives|Import & export)$/,
  Search: /^(Search|Search chats)$/,
  Providers: /^(Providers|Connections)$/,
};
async function openPanel(page: Page, panelName: string, probe: Locator) {
  // After a reload the panel auto-restores via the URL but hydrates slowly;
  // give the probe a grace window before trying to open the panel ourselves.
  if (
    await probe
      .waitFor({ state: "visible", timeout: 4000 })
      .then(() => true)
      .catch(() => false)
  )
    return;
  const back = page.getByRole("button", {
    name: /^(Return to (conversation|chat)|Back to (conversation|chat))$/,
  });
  if (
    await back
      .first()
      .isVisible()
      .catch(() => false)
  )
    await back.first().click();
  const menu = page.getByRole("button", {
    name: "Open chat menu",
    exact: true,
  });
  if (await menu.count()) {
    await menu.click();
    const more = page.getByRole("button", {
      name: "More tools",
      exact: true,
    });
    if (await more.count()) await more.click();
  }
  const rail = page.getByRole("button", {
    name: panelItemNames[panelName] ?? new RegExp(`^${panelName}$`),
  });
  await rail.first().click();
  if (
    await probe
      .waitFor({ state: "visible", timeout: 2500 })
      .then(() => true)
      .catch(() => false)
  )
    return;
  await rail.first().click();
  await expect(probe.first()).toBeVisible();
}

async function closePanel(page: Page, panelName: string) {
  const back = page.getByRole("button", {
    name: /^(Return to (conversation|chat)|Back to (conversation|chat))$/,
  });
  if (
    await back
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    // "Use … in current chat" auto-closes the phone panel asynchronously
    // while we click; a swallowed click followed by the hidden check covers
    // both the manual and the auto-closed path.
    await back
      .first()
      .click({ timeout: 2_000 })
      .catch(() => {});
    await expect(back.first()).toBeHidden({ timeout: 5_000 });
    return;
  }
  const menu = page.getByRole("button", {
    name: "Open chat menu",
    exact: true,
  });
  if (await menu.count()) {
    // Phone: every panel replaces the chat and exposes a Return button,
    // and the chat menu is hidden while a panel is up. No Return and a
    // visible menu therefore means the panel already closed itself.
    return;
  }
  await page
    .getByRole("button", {
      name: panelItemNames[panelName] ?? new RegExp(`^${panelName}$`),
    })
    .first()
    .click();
}

async function expandSettingsSection(
  page: Page,
  title: string,
  content?: Locator,
) {
  const section = page.getByRole("button", { name: title, exact: true });
  if (!(await section.count())) return;
  // When a content probe is given, skip the toggle if the section is
  // already open - clicking an open section would collapse it.
  if (content && (await content.isVisible().catch(() => false))) return;
  await section.click();
}

async function expandPersonaMedia(page: Page) {
  const media = page.getByRole("button", {
    name: "Persona avatar and colors options",
    exact: true,
  });
  if (await media.count()) await media.click();
}

// The persona chip ("Persona: <name>") renders in desktop surfaces; the
// phone app bar omits it (composition/chat screen header keeps only the
// connection + model chips). On phone the attachment is proven by the
// enabled Persona settings tab and the persona panel's selection text.
async function expectPersonaChip(page: Page, name: string) {
  const isDesktop = ((await page.viewportSize()?.width) ?? 0) > 600;
  if (!isDesktop) return;
  await expect(
    page.getByText(`Persona: ${name}`, { exact: true }),
  ).toBeVisible();
}

// Redesigned model settings keep inherited parameters editable with an
// "Inherited" placeholder (features/chat-settings NumericField); the older
// locked-until-inherited affordance no longer exists. Capability gating may
// still hide controls entirely, which also passes.
async function expectControlInherited(
  page: Page,
  role: "textbox" | "switch",
  name: string,
) {
  const control = page.getByRole(role, { name, exact: true }).first();
  if (!(await control.isVisible().catch(() => false))) return;
  if (role === "textbox") {
    await expect(control).toHaveAttribute("placeholder", "Inherited");
    // A settings load still in flight disables the field, so a single
    // read-only snapshot during that window would misread an editable
    // control as capability gating (and an enabled control never renders
    // the explanation). Poll until the field settles either way.
    await expect
      .poll(async () => {
        const settled = await control
          .evaluate((element) => !(element as HTMLInputElement).readOnly)
          .catch(() => false);
        if (settled) return "editable";
        const hinted = await page
          .getByText(/confirmed for this model/i)
          .first()
          .isVisible()
          .catch(() => false);
        return hinted ? "gated" : "loading";
      })
      .not.toBe("loading");
    const editable = await control
      .evaluate((element) => !(element as HTMLInputElement).readOnly)
      .catch(() => false);
    if (editable) return;
    // Unconfirmed-capability fields render read-only with an explanation
    // instead of hiding (chat-settings screen:679-683); that counts as
    // shipped gating too.
    await expect(
      page.getByText(/confirmed for this model/i).first(),
    ).toBeVisible();
  } else {
    await expect(control).toBeVisible();
  }
}

test("Persona profiles can be created, edited, selected, launched and deleted", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openChat(page);
  await openPanel(
    page,
    "Personas",
    page.getByRole("button", { name: "Create Persona", exact: true }),
  );
  await expect(
    page.getByLabel("Persona profile Default", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete Default", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add Default to a group", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Add Default to a group", exact: true }),
  ).toContainText("Add to group");
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
  await expandPersonaMedia(page);
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
  await expandPersonaMedia(page);
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
  await closePanel(page, "Personas");
  await expectPersonaChip(page, "Browser Helper");
  await openPanel(
    page,
    "Settings",
    page
      .getByRole("heading", { name: /^(Chat and model settings|Settings)$/ })
      .first(),
  );
  await expandSettingsSection(page, "Settings scope");
  await expect(
    page.getByRole("tab", { name: "Persona", exact: true }),
  ).toBeEnabled();
  await page.getByRole("tab", { name: "Persona", exact: true }).click();
  await expandSettingsSection(page, "Model instructions");
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("Use the Browser Helper Persona settings.");
  await expect(
    page.getByText(/^(Changes saved|Settings loaded)$/).first(),
  ).toBeVisible();
  await closePanel(page, "Settings");
  await openPanel(
    page,
    "Personas",
    page.getByRole("button", { name: "Create Persona", exact: true }),
  );
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
    page.getByLabel("Persona profile Renamed Browser Helper", { exact: true }),
  ).toBeVisible();
  await closePanel(page, "Personas");
  await expectPersonaChip(page, "Renamed Browser Helper");
  await openPanel(
    page,
    "Personas",
    page.getByRole("button", { name: "Create Persona", exact: true }),
  );
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
  await closePanel(page, "Personas");
  await expectPersonaChip(page, "Browser Helper");
  await openPanel(
    page,
    "Personas",
    page.getByRole("button", { name: "Create Persona", exact: true }),
  );
  await page
    .getByRole("button", {
      name: "Start chat with Browser Helper",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Persona profile Browser Helper", { exact: true }),
  ).toHaveCount(0);
  await expectPersonaChip(page, "Browser Helper");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await openPanel(
    page,
    "Personas",
    page.getByRole("button", { name: "Create Persona", exact: true }),
  );
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
    page.getByRole("button", {
      name: "Use Default in current chat",
      exact: true,
    }),
  ).toBeDisabled();
  await closePanel(page, "Personas");
  await expectPersonaChip(page, "Default");
  await openPanel(
    page,
    "Settings",
    page
      .getByRole("heading", { name: /^(Chat and model settings|Settings)$/ })
      .first(),
  );
  await expandSettingsSection(page, "Settings scope");
  await expect(
    page.getByRole("tab", { name: "Persona", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Default uses global and model settings. Select a custom Persona to edit Persona settings.",
      { exact: true },
    ),
  ).toBeVisible();
  await expandSettingsSection(page, "Model instructions");
  await expect(
    page.getByRole("textbox", { name: "System prompt", exact: true }),
  ).toHaveValue("");
  await closePanel(page, "Settings");
  await openPanel(
    page,
    "Personas",
    page.getByRole("button", { name: "Create Persona", exact: true }),
  );
  await page
    .getByRole("button", { name: "Delete AI Chat assistant", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm Persona deletion", exact: true })
    .click();
  await expect(
    page.getByLabel("Persona profile AI Chat assistant", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await openPanel(
    page,
    "Personas",
    page.getByRole("button", { name: "Create Persona", exact: true }),
  );
  await expect(
    page.getByLabel("Persona profile AI Chat assistant", { exact: true }),
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
  await openPanel(
    page,
    "Memory",
    page.getByRole("button", { name: "Save memory fact", exact: true }),
  );
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
  await openPanel(
    page,
    "Memory",
    page.getByRole("button", { name: "Save memory fact", exact: true }),
  );
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
  await openPanel(
    page,
    "Memory",
    page.getByRole("button", { name: "Save memory fact", exact: true }),
  );
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
  // The conversation avatar renders only in the desktop chat header
  // (composition/chat/screen.tsx); the phone app bar omits it. Product
  // behavior gap, reported rather than hidden.
  const isDesktop = ((await page.viewportSize()?.width) ?? 0) > 600;
  await openChat(page);
  await openPanel(
    page,
    "Settings",
    page
      .getByRole("heading", { name: /^(Chat and model settings|Settings)$/ })
      .first(),
  );
  await expect(
    page
      .getByRole("heading", {
        name: /^(Chat and model settings|Settings)$/,
      })
      .first(),
  ).toBeVisible();
  await expandSettingsSection(page, "Settings scope");
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
  await expandSettingsSection(page, "Model instructions");
  await expandSettingsSection(page, "Advanced model controls");
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
  await context.press("Tab");
  const settingsHeading = page.getByRole("heading", {
    name: "Chat and model settings",
    exact: true,
  });
  if (await settingsHeading.isVisible().catch(() => false))
    await settingsHeading.click();
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
  await expandSettingsSection(page, "Chat appearance");
  await page
    .getByRole("textbox", {
      name: "Chat avatar initials",
      exact: true,
    })
    .fill("CH");
  await page
    .getByRole("button", { name: "Background #EAF2F0", exact: true })
    .click();
  await expandSettingsSection(page, "Context recovery");
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
  await closePanel(page, "Settings");
  if (isDesktop)
    await expect(
      page.getByLabel("Conversation avatar CH", { exact: true }),
    ).toBeVisible();
  await openPanel(
    page,
    "Settings",
    page
      .getByRole("heading", { name: /^(Chat and model settings|Settings)$/ })
      .first(),
  );
  await expandSettingsSection(page, "Context recovery");
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
  if (isDesktop)
    await expect(
      page.getByLabel("Conversation avatar CH", { exact: true }),
    ).toBeVisible();
  await openPanel(
    page,
    "Settings",
    page
      .getByRole("heading", { name: /^(Chat and model settings|Settings)$/ })
      .first(),
  );
  await expandSettingsSection(
    page,
    "Settings scope",
    page.getByRole("tab", { name: "Global", exact: true }),
  );
  await expandSettingsSection(
    page,
    "Model instructions",
    page.getByRole("textbox", { name: "System prompt", exact: true }),
  );
  await expandSettingsSection(
    page,
    "Advanced model controls",
    page.getByRole("textbox", { name: "Context window", exact: true }),
  );
  await expandSettingsSection(
    page,
    "Chat appearance",
    page.getByRole("textbox", { name: "Chat avatar initials", exact: true }),
  );
  await expandSettingsSection(
    page,
    "Context recovery",
    page.getByRole("button", { name: "Cut middle", exact: true }),
  );
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
  if (isDesktop)
    await expect(
      page.getByLabel("Conversation avatar CH", { exact: true }),
    ).toBeVisible();
  // URL-restore hydration can remount the Settings panel right after the
  // post-reload expansion, leaving sections collapsed again; re-expand on
  // demand before touching the scope tabs.
  if (
    !(await page
      .getByRole("tab", { name: "Global", exact: true })
      .isVisible()
      .catch(() => false))
  )
    await expandSettingsSection(
      page,
      "Settings scope",
      page.getByRole("tab", { name: "Global", exact: true }),
    );
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
  await openPanel(
    page,
    "Personas",
    page.getByRole("button", { name: "Create Persona", exact: true }),
  );
  await page
    .getByRole("button", { name: "Create Persona", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Avatar Helper");
  await expandPersonaMedia(page);
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
  await openPanel(
    page,
    "Personas",
    page.getByRole("button", { name: "Create Persona", exact: true }),
  );
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
  await expandPersonaMedia(page);
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
  await openPanel(
    page,
    "Personas",
    page.getByRole("button", { name: "Create Persona", exact: true }),
  );
  await expect(avatar).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Edit profile for Avatar Helper",
      exact: true,
    })
    .click();
  await expandPersonaMedia(page);
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
  await openPanel(
    page,
    "Settings",
    page
      .getByRole("heading", { name: /^(Chat and model settings|Settings)$/ })
      .first(),
  );
  const context = page.getByRole("textbox", {
    name: "Context window",
    exact: true,
  });
  await expandSettingsSection(page, "Advanced model controls");
  await context.fill("");
  await context.pressSequentially("2048", { delay: 50 });
  await context.press("Tab");
  await expect(context).toHaveValue("2048");
  const typingHeading = page.getByRole("heading", {
    name: "Chat and model settings",
    exact: true,
  });
  if (await typingHeading.isVisible().catch(() => false))
    await typingHeading.click();
  await expect(
    page
      .getByText(/^(Changes saved|Settings loaded)$/)
      .or(
        page.getByText(
          "Context settings changed. Reload model context to apply them.",
          { exact: true },
        ),
      )
      .first(),
  ).toBeVisible();
  await page.reload();
  await openPanel(
    page,
    "Settings",
    page
      .getByRole("heading", { name: /^(Chat and model settings|Settings)$/ })
      .first(),
  );
  await expandSettingsSection(page, "Advanced model controls");
  await expect(context).toHaveValue("2048");
  await expectControlInherited(page, "textbox", "Temperature");
  for (const label of [
    "Top P",
    "Top K",
    "Min P",
    "Repeat penalty",
    "Maximum output tokens",
    "GPU layers",
  ]) {
    await expectControlInherited(page, "textbox", label);
  }
  for (const label of [
    "Reasoning",
    "JSON / structured output",
    "Flash attention",
    "KV cache offload",
    "Memory map weights",
  ]) {
    await expectControlInherited(page, "switch", label);
  }
  await expandSettingsSection(page, "Settings scope");
  // Whether the Model scope is enabled depends on a model being registered
  // for the chat — a running companion/seeded provider changes that per
  // machine — so assert the shipped scope set exists and the chat scope is
  // the selected one.
  for (const scopeTab of ["Global", "Model", "Persona", "This chat"]) {
    await expect(
      page.getByRole("tab", { name: scopeTab, exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("tab", { name: "This chat", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
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
  await page.getByRole("button", { name: /^(Providers|Connections)$/ }).click();
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
