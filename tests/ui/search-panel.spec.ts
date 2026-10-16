import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mobileArchiveZip } from "../../apps/mobile/composition/chat/archives/zip";

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

async function startChat(page: Page) {
  await page.goto("/");
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

async function openSearch(page: Page) {
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Search conversations", exact: true }),
  ).toBeVisible();
  return page.getByLabel("Search saved conversations", { exact: true });
}

async function searchFor(page: Page, query: string) {
  const input = page.getByLabel("Search saved conversations", { exact: true });
  await input.fill("");
  await expect(
    page.getByText(
      "Enter a word or phrase to search your saved conversations.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await input.fill(query);
  if (!query.trim()) return;
  // Wait for this query's debounce and database read, including repeated no-result searches.
  const searching = page.getByText(/^Searching saved text/);
  await expect(searching).toBeVisible();
  await expect(searching).toHaveCount(0);
}

async function expectSourceUncovered(page: Page, paragraph: Locator) {
  const latest = page.getByRole("button", {
    name: "Scroll to latest message",
    exact: true,
  });
  await expect(async () => {
    if (!(await latest.isVisible())) return;
    const textBox = await paragraph.boundingBox();
    const buttonBox = await latest.boundingBox();
    expect(textBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    const overlaps =
      textBox!.x < buttonBox!.x + buttonBox!.width &&
      textBox!.x + textBox!.width > buttonBox!.x &&
      textBox!.y < buttonBox!.y + buttonBox!.height &&
      textBox!.y + textBox!.height > buttonBox!.y;
    expect(overlaps, "The Latest message button covers source text").toBe(
      false,
    );
  }).toPass({ timeout: 5_000 });
}

test("saved title and message search scopes, literal characters and exact older sources survive reopening", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const alphaTitle = "Search Alpha %_ O'Brien";
  const alphaQuestion = "Scope sharedtoken alpha question %_ O'Brien.";
  const alphaAnswer = "Source exact assistant quartzmarker.";
  const freshAnswer = "Fresh answer after opening an older source.";
  let fixtureRequests = 0;
  await page.route(
    "https://search-follow-fixture.test/v1/chat/completions",
    async (route) => {
      fixtureRequests++;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: freshAnswer } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`,
      });
    },
  );
  // Imported fixtures use the real archive UI and SQLite store; no model response is requested.
  const archive = {
    version: 1,
    conversations: [
      {
        id: "search-alpha",
        title: alphaTitle,
        messages: [
          { id: "alpha-source-user", role: "user", content: alphaQuestion },
          {
            id: "alpha-source-assistant",
            role: "assistant",
            content: alphaAnswer,
          },
          ...Array.from({ length: 14 }, (_, index) => [
            {
              id: `alpha-later-user-${index}`,
              role: "user",
              content: Array.from(
                { length: 8 },
                (_, line) => `Later question ${index + 1}, line ${line + 1}.`,
              ).join("\n"),
            },
            {
              id: `alpha-later-assistant-${index}`,
              role: "assistant",
              content: `Later answer ${index + 1}.`,
            },
          ]).flat(),
        ],
      },
      {
        id: "search-beta",
        title: "Search Beta",
        messages: [
          {
            id: "beta-source-user",
            role: "user",
            content: "Scope sharedtoken beta question.",
          },
          {
            id: "beta-source-assistant",
            role: "assistant",
            content: "Beta answer.",
          },
        ],
      },
      {
        id: "search-gamma",
        title: "Search Gamma",
        messages: [
          {
            id: "gamma-source-user",
            role: "user",
            content: "Unrelated third question.",
          },
          {
            id: "gamma-source-assistant",
            role: "assistant",
            content: "Gamma answer.",
          },
        ],
      },
    ],
  };
  await startChat(page);
  await page.getByRole("button", { name: "Archives", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Import LM Studio export", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "search-real-store-fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .getByRole("button", { name: `Open ${alphaTitle}`, exact: true })
    .click();

  await openSearch(page);
  await expect(
    page.getByText(
      "Enter a word or phrase to search your saved conversations.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Semantic", exact: true }),
  ).toBeDisabled();
  await searchFor(page, "sharedtoken");
  const alphaHit = page.getByRole("button", {
    name: `Open ${alphaTitle}, user message`,
    exact: true,
  });
  const betaHit = page.getByRole("button", {
    name: "Open Search Beta, user message",
    exact: true,
  });
  await expect(alphaHit).toBeVisible();
  await expect(betaHit).toBeVisible();
  await expect(page.getByText("2 results", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "This chat", exact: true }).click();
  await expect(alphaHit).toBeVisible();
  await expect(betaHit).toHaveCount(0);
  await expect(page.getByText("1 results", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All chats", exact: true }).click();
  await expect(betaHit).toBeVisible();
  await searchFor(page, "Search Beta");
  await expect(
    page.getByRole("button", { name: "Open Search Beta", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Title match", { exact: true })).toBeVisible();
  for (const literal of ["%", "_", "O'Brien", "%_ O'Brien"]) {
    await searchFor(page, literal);
    await expect(page.getByText("2 results", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Open ${alphaTitle}`, exact: true }),
    ).toBeVisible();
    await expect(alphaHit).toBeVisible();
    await expect(betaHit).toHaveCount(0);
  }
  await searchFor(page, "no-saved-match-xyz");
  await expect(
    page.getByText("No saved titles or messages match this search.", {
      exact: true,
    }),
  ).toBeVisible();
  await searchFor(page, "   ");
  await expect(
    page.getByText(
      "Enter a word or phrase to search your saved conversations.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(alphaHit).toHaveCount(0);
  await searchFor(page, "sharedtoken alpha");
  await alphaHit.click();
  const userSource = page.getByLabel(`Your message: ${alphaQuestion}`, {
    exact: true,
  });
  await expect(userSource).toBeInViewport({ ratio: 0.9 });
  await expectSourceUncovered(
    page,
    page.getByText(alphaQuestion, { exact: true }),
  );
  await expect(page.getByTestId("source-message")).toContainText(alphaQuestion);
  await expect(
    page.getByRole("heading", { name: "Source message", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("search-exact-user-source.png"),
    fullPage: true,
  });

  await openSearch(page);
  await searchFor(page, "quartzmarker");
  await page
    .getByRole("button", {
      name: `Open ${alphaTitle}, assistant message`,
      exact: true,
    })
    .click();
  const assistantSource = page
    .getByTestId("assistant-response-text")
    .filter({ hasText: alphaAnswer });
  await expect(assistantSource).toBeInViewport({ ratio: 0.9 });
  await expectSourceUncovered(
    page,
    page.getByText(alphaAnswer, { exact: true }),
  );
  await expect(page.getByTestId("source-message")).toContainText(alphaAnswer);
  await expect(
    page.getByRole("heading", { name: "Source message", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("search-exact-assistant-source.png"),
    fullPage: true,
  });
  await page.reload();
  await openSearch(page);
  await searchFor(page, "sharedtoken");
  await expect(alphaHit).toBeVisible();
  await expect(betaHit).toBeVisible();
  await alphaHit.click();
  await expect(userSource).toBeInViewport({ ratio: 0.9 });
  await expectSourceUncovered(
    page,
    page.getByText(alphaQuestion, { exact: true }),
  );
  await page.screenshot({
    path: testInfo.outputPath("search-durable-source-reopened.png"),
    fullPage: true,
  });
  // Select the intercepted fixture on this imported conversation, then return to its older source.
  const phone = testInfo.project.name === "phone";
  if (phone)
    await page.getByRole("button", { name: "Choose chat connection" }).click();
  else await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your connections", exact: true }),
  ).toBeVisible();
  const addFixture = page.getByRole("button", { name: "Add provider" });
  if (await addFixture.count()) await addFixture.click();
  const otherFixture = page.getByRole("button", {
    name: "Other",
    exact: true,
  });
  if (await otherFixture.count()) await otherFixture.click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Search follow fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill("https://search-follow-fixture.test/v1");
  await page
    .getByRole("textbox", { name: "Exact chat model ID", exact: true })
    .fill("search-follow");
  await page
    .getByRole("button", { name: "Save and use provider", exact: true })
    .click();
  await openSearch(page);
  await searchFor(page, "sharedtoken alpha");
  await alphaHit.click();
  await expect(page.getByTestId("source-message")).toContainText(alphaQuestion);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Continue from the opened source with a fresh answer.");
  await page.getByTestId("advanced-composer-send").click();
  const fresh = page
    .getByTestId("assistant-response-text")
    .filter({ hasText: freshAnswer });
  await expect(fresh).toBeInViewport({ ratio: 0.9 });
  await expect(page.getByTestId("source-message")).toHaveCount(0);
  await expect(
    page.getByText("Response complete", { exact: true }).last(),
  ).toBeVisible();
  expect(fixtureRequests).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("search-source-to-fresh-reply.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("search excludes archived unselected variants, superseded base text and private parts after reload", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const oldText = "Obsolete quasarvariant answer.";
  const currentText = "Current nebulavariant answer.";
  const fixtureConversation = {
    id: "variant-archive",
    title: "Variant archive",
    messages: [
      {
        id: "variant-user",
        role: "user",
        parts: [
          { type: "text", text: "Saved question with multiple generations." },
        ],
      },
      {
        id: "variant-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Superseded baseghost answer." }],
        variants: [
          {
            id: "variant-old",
            parts: [{ type: "text", text: oldText }],
            selected: false,
          },
          {
            id: "variant-current",
            parts: [
              { type: "text", text: currentText },
              {
                type: "reasoning",
                text: "Private privatechainmarker reasoning.",
              },
              {
                type: "tool-result",
                invocationId: "fixture-tool",
                content: "toolresultmarker",
              },
            ],
            selected: true,
          },
        ],
      },
    ],
  };
  // The archive importer persists real variant rows, including the unselected old generation.
  const manifest = {
    schema: "locallab-chat-archive",
    version: 1,
    exportedAt: "2026-09-27T00:00:00.000Z",
    conversations: [fixtureConversation],
    assets: [],
  };
  const encoder = new TextEncoder();
  const bytes = await mobileArchiveZip.encode([
    { path: "manifest.json", bytes: encoder.encode(JSON.stringify(manifest)) },
    {
      path: "chats/variant-archive.json",
      bytes: encoder.encode(JSON.stringify(fixtureConversation)),
    },
  ]);
  await startChat(page);
  await page.getByRole("button", { name: "Archives", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Import ZIP archive", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "search-variants.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByTestId("assistant-response-text")).toContainText(
    currentText,
  );
  await expect(page.getByText(oldText, { exact: true })).toHaveCount(0);
  await openSearch(page);
  for (const excluded of [
    "quasarvariant",
    "baseghost",
    "privatechainmarker",
    "toolresultmarker",
  ]) {
    await searchFor(page, excluded);
    await expect(
      page.getByText("No saved titles or messages match this search.", {
        exact: true,
      }),
    ).toBeVisible();
  }
  await searchFor(page, "nebulavariant");
  await page
    .getByRole("button", {
      name: "Open Variant archive, assistant message",
      exact: true,
    })
    .click();
  await expect(page.getByTestId("assistant-response-text")).toContainText(
    currentText,
  );
  await expect(page.getByTestId("assistant-response-text")).toBeInViewport({
    ratio: 0.9,
  });
  await expect(page.getByTestId("source-message")).toContainText(currentText);
  await page.reload();
  await openSearch(page);
  await searchFor(page, "quasarvariant");
  await expect(
    page.getByText("No saved titles or messages match this search.", {
      exact: true,
    }),
  ).toBeVisible();
  await searchFor(page, "nebulavariant");
  await expect(
    page.getByRole("button", {
      name: "Open Variant archive, assistant message",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("search-selected-variant-durable.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Archives", exact: true }).click();
  const pendingDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export all chats as ZIP", exact: true })
    .click();
  const download = await pendingDownload;
  const exportedPath = testInfo.outputPath("durable-search-variants.zip");
  await download.saveAs(exportedPath);
  expect(await download.failure()).toBeNull();
  const exported = await mobileArchiveZip.decode(await readFile(exportedPath));
  const savedManifest = JSON.parse(
    new TextDecoder().decode(
      exported.find((entry) => entry.path === "manifest.json")!.bytes,
    ),
  );
  const saved = savedManifest.conversations.find(
    (conversation: { title: string }) =>
      conversation.title === "Variant archive",
  );
  expect(
    saved.messages[1].variants.map(
      (variant: { parts: unknown[]; selected: boolean }) => ({
        parts: variant.parts,
        selected: variant.selected,
      }),
    ),
  ).toEqual(
    fixtureConversation.messages[1]!.variants!.map((variant) => ({
      parts: variant.parts,
      selected: variant.selected,
    })),
  );
  expect(errors).toEqual([]);
});
