import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { mobileArchiveZip } from "../../apps/mobile/composition/chat/archives/zip";

const decoder = new TextDecoder();
const shortenedNotice =
  "Attachment text was shortened to fit this message. Original files remain saved.";

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

async function fixtureProvider(page: Page) {
  const requests: Array<{
    messages: Array<{ role: string; content: unknown }>;
  }> = [];
  await page.route(
    "https://attachment-boundary-fixture.test/v1/chat/completions",
    async (route) => {
      requests.push(route.request().postDataJSON());
      const answer = `Boundary fixture answer ${requests.length}.`;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
      });
    },
  );
  const heading = page.getByRole("heading", {
    name: "Your connections",
    exact: true,
  });
  const rail = page.getByRole("button", { name: "Providers", exact: true });
  const appbar = page.getByRole("button", {
    name: "Choose chat connection",
  });
  if (await appbar.count()) await appbar.click();
  else await rail.first().click();
  await heading
    .waitFor({ state: "visible", timeout: 8000 })
    .catch(() => {});
  const add = page.getByRole("button", { name: "Add provider" });
  const editor = page.getByRole("region", {
    name: "Provider connection editor",
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await editor.isVisible().catch(() => false)) break;
    if (await add.count()) await add.first().click().catch(() => {});
    if (
      await editor
        .waitFor({ state: "visible", timeout: 2500 })
        .then(() => true)
        .catch(() => false)
    )
      break;
  }
  const other = page.getByRole("button", {
    name: "Other",
    exact: true,
  });
  if (await other.count()) await other.click();
  const name = page.getByRole("textbox", {
    name: "Provider name",
    exact: true,
  });
  if (!(await name.count()))
    await page.getByRole("button", { name: "Connection settings" }).click();
  await name.fill("Attachment boundary fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill("https://attachment-boundary-fixture.test/v1");
  await page.getByRole("button", { name: "Enter custom model ID" }).click();
  await page
    .getByRole("textbox", { name: "Exact chat model ID", exact: true })
    .fill("attachment-boundary");
  const save = page
    .getByRole("button", { name: "Save and use provider", exact: true })
    .first();
  await save.click();
  const composerBox = page.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  await composerBox
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await composerBox.isVisible().catch(() => false)) break;
    const back = page
      .getByRole("button", {
        name: /^(Return to (conversation|chat)|Back to chat)$/,
      })
      .first();
    if (await back.isVisible().catch(() => false)) {
      await back.click({ timeout: 3000 }).catch(() => {});
      continue;
    }
    const closeRail = page
      .getByRole("button", { name: /^(Providers|Connections)$/ })
      .first();
    if (await closeRail.isVisible().catch(() => false)) {
      await closeRail.click({ timeout: 3000 }).catch(() => {});
      continue;
    }
    break;
  }
  await expect(composerBox).toBeVisible();
  return requests;
}

async function closeMessageTools(page: Page) {
  // Phone opens Attach through a modal tools sheet whose backdrop covers
  // the whole page until closed; desktop has no sheet.
  const closeTools = page
    .getByRole("button", {
      name: /^(Close|Hide) message tools$/,
    })
    .first();
  if (await closeTools.isVisible().catch(() => false)) await closeTools.click();
}

async function choose(
  page: Page,
  button: string,
  name: string,
  mimeType: string,
  bytes: Buffer,
) {
  const attachTools = page.getByRole("button", {
    name: "Show message tools",
    exact: true,
  });
  const target = page.getByRole("button", { name: button, exact: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await attachTools.count()) await attachTools.click();
    const chooser = page
      .waitForEvent("filechooser", { timeout: 5000 })
      .catch(() => null);
    await target.click();
    const picked = await chooser;
    if (picked) {
      await picked.setFiles({ name, mimeType, buffer: bytes });
      await closeMessageTools(page);
      return;
    }
    await page.waitForTimeout(750);
  }
  throw new Error(`Clicking "${button}" never opened a file chooser`);
}

async function download(page: Page, button: string, path: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const result = await pending;
  await result.saveAs(path);
  expect(await result.failure()).toBeNull();
  return readFile(path);
}

async function archiveSnapshot(page: Page, path: string) {
  const exportZip = page.getByRole("button", {
    name: "Export all chats as ZIP",
    exact: true,
  });
  if (!(await exportZip.isVisible().catch(() => false))) {
    const menu = page.getByRole("button", {
      name: "Open chat menu",
      exact: true,
    });
    if (await menu.count()) await menu.click();
    await page
      .getByRole("button", { name: /^(Archives|Import & export)$/ })
      .first()
      .click();
  }
  await expect(exportZip).toBeVisible();
  const entries = await mobileArchiveZip.decode(
    await download(page, "Export all chats as ZIP", path),
  );
  const manifest = JSON.parse(
    decoder.decode(
      entries.find((entry) => entry.path === "manifest.json")!.bytes,
    ),
  );
  await page
    .getByRole("button", {
      name: /^(Return to (conversation|chat)|Back to chat)$/,
    })
    .first()
    .click();
  return { entries, manifest };
}

function documentText(label: string, character: string) {
  const head = `${label}_BEGIN\n`;
  const tail = `\n${label}_END`;
  return head + character.repeat(40_000 - head.length - tail.length) + tail;
}

test("chooser cancel, sequential originals, removal and aggregate text shortening preserve saved bytes", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await startChat(page);
  const requests = await fixtureProvider(page);
  const draft =
    "Attachment boundary draft stays unchanged through cancellation.";
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill(draft);
  const messageTools = page.getByRole("button", {
    name: "Show message tools",
    exact: true,
  });
  if (await messageTools.count()) await messageTools.click();
  const pendingChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  const chooser = await pendingChooser;
  // Exercise the actual transient chooser input's cancel notification. Physical OS Escape is separate.
  await chooser
    .element()
    .evaluate((input) => input.dispatchEvent(new Event("cancel")));
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await closeMessageTools(page);
  await expect(message).toHaveValue(draft);
  const canceled = await archiveSnapshot(
    page,
    testInfo.outputPath("after-chooser-cancel.zip"),
  );
  expect(canceled.manifest.conversations).toHaveLength(1);
  expect(canceled.manifest.conversations[0].messages).toEqual([]);
  expect(
    canceled.entries.some((entry) => entry.path.startsWith("assets/blobs/")),
  ).toBe(false);
  await expect(message).toHaveValue(draft);

  const first = documentText("FIRST", "A");
  const second = documentText("SECOND", "B");
  await choose(
    page,
    "Attach",
    "first-original.txt",
    "text/plain",
    Buffer.from(first),
  );
  await expect(
    page.getByRole("button", {
      name: "Remove first-original.txt",
      exact: true,
    }),
  ).toBeVisible();
  await choose(
    page,
    "Attach",
    "removed-original.txt",
    "text/plain",
    Buffer.from("REMOVED_ORIGINAL_BYTES"),
  );
  await expect(
    page.getByRole("button", {
      name: "Remove removed-original.txt",
      exact: true,
    }),
  ).toBeVisible();
  await choose(
    page,
    "Attach",
    "second-original.txt",
    "text/plain",
    Buffer.from(second),
  );
  await page
    .getByRole("button", { name: "Remove removed-original.txt", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Remove removed-original.txt",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Remove first-original.txt",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Remove second-original.txt",
      exact: true,
    }),
  ).toBeVisible();
  await expect(message).toHaveValue(draft);
  if (
    !(await page
      .getByRole("tab", { name: "Global", exact: true })
      .isVisible()
      .catch(() => false))
  ) {
    const menu = page.getByRole("button", {
      name: "Open chat menu",
      exact: true,
    });
    if (await menu.count()) await menu.click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  if (
    !(await page
      .getByRole("tab", { name: "Global", exact: true })
      .isVisible()
      .catch(() => false))
  ) {
    // Phone keeps the scope tabs inside the collapsed "Settings scope"
    // section; desktop reaches them directly.
    const scopeSection = page.getByRole("button", {
      name: "Settings scope",
      exact: true,
    });
    if (await scopeSection.count()) await scopeSection.click();
  }
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  const context = page.getByRole("textbox", {
    name: "Context window",
    exact: true,
  });
  const advanced = page.getByRole("button", {
    name: "Advanced model controls",
    exact: true,
  });
  if (
    (await advanced.count()) &&
    !(await context.isVisible().catch(() => false))
  )
    await advanced.click();
  await context.fill("32768");
  await context.press("Tab");
  await expect(
    page.getByText("Saving settings...", { exact: true }),
  ).toHaveCount(0);
  const backSettings = page.getByRole("button", {
    name: /^(Return to conversation|Back to (conversation|chat))$/,
  });
  if (await backSettings.first().isVisible().catch(() => false))
    await backSettings.first().click();
  else {
    const menu = page.getByRole("button", {
      name: "Open chat menu",
      exact: true,
    });
    if (await menu.count()) await menu.click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText("Boundary fixture answer 1.");
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toBeInViewport({ ratio: 0.9 });
  expect(requests).toHaveLength(1);
  const sentText = requests[0]!.messages
    .filter((item) => item.role === "user")
    .map((item) => String(item.content))
    .join("\n");
  expect(sentText).toContain(first);
  expect(sentText).toContain(second.slice(0, 24_000));
  expect(sentText).not.toContain("SECOND_END");
  expect(sentText).not.toContain("REMOVED_ORIGINAL_BYTES");
  await writeFile(
    testInfo.outputPath("aggregate-fixture-request.json"),
    JSON.stringify(requests[0], null, 2),
  );
  const saved = await archiveSnapshot(
    page,
    testInfo.outputPath("full-originals-after-send.zip"),
  );
  const originals = saved.entries
    .filter((entry) => entry.path.startsWith("assets/blobs/"))
    .map((entry) => decoder.decode(entry.bytes));
  expect(originals).toContain(first);
  expect(originals).toContain(second);
  expect(originals).not.toContain("REMOVED_ORIGINAL_BYTES");
  expect(
    saved.manifest.conversations[0].messages.filter(
      (item: { role: string }) => item.role === "user",
    ),
  ).toHaveLength(1);
  await expect(page.getByText(shortenedNotice, { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("aggregate-shortening-and-originals.png"),
    fullPage: true,
  });
  await message.fill("Next message has no new attachments.");
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText("Boundary fixture answer 2.");
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toBeInViewport({ ratio: 0.9 });
  await expect(page.getByText(shortenedNotice, { exact: true })).toHaveCount(0);
  await page.reload();
  // After reload the app restores the existing chat, whose app-bar heading
  // is the conversation title (not "LocalLab"); the new-chat header button
  // is the stable shipped anchor on both platforms (the connection picker
  // only exists in the phone header).
  await expect(
    page.getByRole("button", { name: /^(New chat|Start a new chat)$/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText("Boundary fixture answer 2.");
  const reopened = await archiveSnapshot(
    page,
    testInfo.outputPath("reopened-originals.zip"),
  );
  const reopenedOriginals = reopened.entries
    .filter((entry) => entry.path.startsWith("assets/blobs/"))
    .map((entry) => decoder.decode(entry.bytes));
  expect(reopenedOriginals).toEqual(expect.arrayContaining([first, second]));
  await choose(
    page,
    "Attach",
    "reset-shortening.txt",
    "text/plain",
    Buffer.from("R".repeat(64_001)),
  );
  await expect(
    page.getByRole("button", {
      name: "Remove reset-shortening.txt",
      exact: true,
    }),
  ).toBeVisible();
  await message.fill("Check the next-chat notice reset.");
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText("Boundary fixture answer 3.");
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toBeInViewport({ ratio: 0.9 });
  await expect(page.getByText(shortenedNotice, { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: /^(New chat|Start a new chat)$/ })
    .first()
    .click();
  await expect(page.getByText(shortenedNotice, { exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(3);
  expect(errors).toEqual([]);
});

test("unverified vision rejects an image before provider contact and allows recovery by removing it", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await startChat(page);
  const requests = await fixtureProvider(page);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCq0AAAAASUVORK5CYII=",
    "base64",
  );
  await choose(page, "Attach", "vision-boundary.png", "image/png", png);
  const image = page.getByRole("button", {
    name: "Remove vision-boundary.png",
    exact: true,
  });
  await expect(image).toBeVisible();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const draft = "Preserve this image boundary draft after refusal.";
  await message.fill(draft);
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText(/This model has no verified image support/).first(),
  ).toBeVisible();
  await expect(message).toHaveValue(draft);
  await expect(image).toBeVisible();
  expect(requests).toHaveLength(0);
  const rejected = await archiveSnapshot(
    page,
    testInfo.outputPath("vision-rejected-before-admission.zip"),
  );
  expect(rejected.manifest.conversations[0].messages).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("vision-refusal-preserves-draft.png"),
    fullPage: true,
  });
  await image.click();
  await expect(image).toHaveCount(0);
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText("Boundary fixture answer 1.");
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toBeInViewport({ ratio: 0.9 });
  await expect(message).toHaveValue("");
  expect(requests).toHaveLength(1);
  const accepted = await archiveSnapshot(
    page,
    testInfo.outputPath("vision-removal-recovered.zip"),
  );
  expect(
    accepted.manifest.conversations[0].messages.filter(
      (item: { role: string }) => item.role === "user",
    ),
  ).toHaveLength(1);
  expect(
    accepted.entries.some((entry) => entry.path.startsWith("assets/blobs/")),
  ).toBe(false);
  expect(errors).toEqual([]);
});

test("mixed user and assistant fenced code exports complete real TXT and PDF raster pages", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const user =
    "USER_MARKER\nPlease preserve this scaffold and Unicode: café 日本語.\n```python\ndef add(a, b):\n    # User scaffold retains indentation.\n    pass\n```\nUSER_END";
  const assistant =
    "ASSISTANT_MARKER\nWorking implementation:\n```python\ndef add(a, b):\n    return a + b\n\n" +
    Array.from(
      { length: 65 },
      (_, index) =>
        `# Code line ${String(index + 1).padStart(2, "0")}: readable continuation across PDF page boundaries.`,
    ).join("\n") +
    "\n```\nFINAL_ASSISTANT_END";
  await startChat(page);
  const importExport = page.getByRole("button", {
    name: "Import LM Studio export",
    exact: true,
  });
  if (!(await importExport.isVisible().catch(() => false))) {
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
    await page
      .getByRole("button", { name: /^(Archives|Import & export)$/ })
      .first()
      .click();
  }
  await expect(importExport).toBeVisible();
  await choose(
    page,
    "Import LM Studio export",
    "mixed-pdf-source.json",
    "application/json",
    Buffer.from(
      JSON.stringify({
        version: 1,
        conversations: [
          {
            id: "mixed-pdf",
            title: "Mixed fenced code export",
            messages: [
              { id: "mixed-user", role: "user", content: user },
              { id: "mixed-assistant", role: "assistant", content: assistant },
            ],
          },
        ],
      }),
    ),
  );
  await page
    .getByRole("button", {
      name: /^(Return to (conversation|chat)|Back to chat)$/,
    })
    .first()
    .click();
  const openMixed = page.getByRole("button", {
    name: "Open Mixed fenced code export",
    exact: true,
  });
  if (!(await openMixed.isVisible().catch(() => false))) {
    const menu = page.getByRole("button", {
      name: "Open chat menu",
      exact: true,
    });
    if (await menu.count()) await menu.click();
    await page.getByRole("button", { name: "Library", exact: true }).click();
  }
  await openMixed.click();
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText("FINAL_ASSISTANT_END");
  const exportTxt = page.getByRole("button", {
    name: "Export chat as TXT",
    exact: true,
  });
  if (!(await exportTxt.isVisible().catch(() => false))) {
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
    await page
      .getByRole("button", { name: /^(Archives|Import & export)$/ })
      .first()
      .click();
  }
  await expect(exportTxt).toBeVisible();
  const txt = await download(
    page,
    "Export chat as TXT",
    testInfo.outputPath("mixed-chat.txt"),
  );
  expect(decoder.decode(txt)).toContain(user);
  expect(decoder.decode(txt)).toContain(assistant);
  const pdf = await download(
    page,
    "Export chat as PDF",
    testInfo.outputPath("mixed-chat.pdf"),
  );
  expect(pdf.subarray(0, 8).toString()).toBe("%PDF-1.4");
  const syntax = pdf.toString("latin1");
  const pageCount = Number(syntax.match(/\/Type \/Pages \/Count (\d+)/)?.[1]);
  expect(pageCount).toBeGreaterThan(1);
  const imageObjects =
    /\d+ 0 obj\n<< \/Type \/XObject \/Subtype \/Image[^\n]+\/Length (\d+) >>\nstream\n/g;
  let match: RegExpExecArray | null;
  let rasters = 0;
  while ((match = imageObjects.exec(syntax))) {
    const start = match.index + match[0].length;
    const raster = pdf.subarray(start, start + Number(match[1]));
    expect(raster.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(raster.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    const path = testInfo.outputPath(`mixed-chat-pdf-page-${++rasters}.jpg`);
    await writeFile(path, raster);
    await testInfo.attach(`actual PDF raster page ${rasters}`, {
      path,
      contentType: "image/jpeg",
    });
  }
  expect(rasters).toBe(pageCount);
  // Browser PDFs preserve readable Unicode through images; selectable/searchable PDF text is unavailable.
  expect(syntax).not.toContain("/Type /Font");
  await page.screenshot({
    path: testInfo.outputPath("mixed-code-export-controls.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
