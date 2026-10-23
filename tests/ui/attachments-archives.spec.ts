import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mobileArchiveZip } from "../../apps/mobile/composition/chat/archives/zip";

const decoder = new TextDecoder();

// Phone exposes Archives inside the chat menu (drawer, behind "More
// tools"); desktop keeps the rail button visible.
async function openArchives(page: Page) {
  const item = page
    .getByRole("button", { name: /^(Archives|Import & export)$/ })
    .first();
  if (await item.isVisible().catch(() => false)) return item.click();
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
  await item.click();
}
const apiBase = process.env.LOCALLAB_LIVE_API_BASE;
const model = process.env.LOCALLAB_LIVE_MODEL ?? "local-coder";
const attachmentText =
  "The flower in this note is marigold.\nUTF-8 survives: café, 日本語, 🌻.";
const importText = "Archive browser verification: café, 日本語, 🌻.";
const longImport = `${importText}\n${Array.from({ length: 110 }, (_, index) => `Archive line ${index + 1}: this line must remain in the complete PDF and text downloads.`).join("\n")}`;
const lmStudioFile = {
  name: "lmstudio-browser.json",
  mimeType: "application/json",
  buffer: Buffer.from(
    JSON.stringify({
      version: 1,
      conversations: [
        {
          id: "browser-source",
          title: "Browser archive verification",
          messages: [
            { id: "browser-message", role: "user", content: longImport },
          ],
        },
      ],
    }),
  ),
};

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
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const attachTools = page.getByRole("button", {
      name: "Show message tools",
      exact: true,
    });
    if (await attachTools.count()) await attachTools.click();
    const chooser = page
      .waitForEvent("filechooser", { timeout: 5000 })
      .catch(() => null);
    await page.getByRole("button", { name: button, exact: true }).click();
    const picked = await chooser;
    if (picked) {
      await picked.setFiles(file);
      await closeMessageTools(page);
      return;
    }
    await page.waitForTimeout(750);
  }
  throw new Error(`Clicking "${button}" never opened a file chooser`);
}

async function download(
  page: Page,
  button: string,
  path: string,
): Promise<Buffer> {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const result = await pending;
  await result.saveAs(path);
  expect(await result.failure()).toBeNull();
  return readFile(path);
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

async function startChat(page: Page) {
  await page.goto("/");
  await expandSetupPreferences(page);
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page.getByRole("button", { name: /^Choose light theme/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page
      .getByRole("heading", { name: /^(AI Chat|Offline chat)$/, exact: true })
      .first(),
  ).toBeVisible();
}

test("real browser file intake and archive downloads round trip persistent bytes", async ({
  page,
}, testInfo) => {
  test.skip(
    !apiBase,
    "Set LOCALLAB_LIVE_API_BASE to exercise real generation with an attachment.",
  );
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await startChat(page);
  await page
    .getByRole("button", { name: /^(Archives|Import & export)$/ })
    .first()
    .click();
  await choose(page, "Import LM Studio export", lmStudioFile);
  await expect(
    page.getByText(importText, { exact: false }).first(),
  ).toBeVisible();

  await page
    .getByRole("button", { name: /^(Archives|Import & export)$/ })
    .first()
    .click();
  const txt = await download(
    page,
    "Export chat as TXT",
    testInfo.outputPath("imported-chat.txt"),
  );
  expect(decoder.decode(txt)).toContain(longImport);
  const pdf = await download(
    page,
    "Export chat as PDF",
    testInfo.outputPath("imported-chat.pdf"),
  );
  expect(pdf.subarray(0, 8).toString()).toBe("%PDF-1.4");
  expect(pdf.toString("latin1")).toMatch(/\/Type \/Pages \/Count [3-9]/);
  await page.screenshot({
    path: testInfo.outputPath("archive-downloads.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: /^(Return to (conversation|chat)|Back to chat)$/,
    })
    .first()
    .click();
  await page
    .getByRole("button", { name: /^(New chat|Start a new chat)$/ })
    .first()
    .click();
  await expect(page.getByText(importText, { exact: false })).toHaveCount(0);

  // This is the running local server, without intercepted or fabricated responses.
  await page.getByRole("button", { name: /^(Providers|Connections)$/ }).click();
  await page.getByRole("tab", { name: "compatible", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Attachment local server");
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
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("<|think_off|>\nReply with one brief sentence.");
  const outputLimit = page.getByRole("textbox", {
    name: "Maximum output tokens",
    exact: true,
  });
  await expect(outputLimit).toBeEditable();
  await outputLimit.fill("768");
  await outputLimit.press("Tab");
  await expect(
    page.getByText("Saving settings...", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await choose(page, "Attach", {
    name: "verification.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(attachmentText),
  });
  await expect(
    page.getByRole("button", { name: "Remove verification.txt", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("attachment-selected.png"),
    fullPage: true,
  });
  const request = page.waitForRequest(
    (value) =>
      value.method() === "POST" &&
      decodeURIComponent(value.url()).endsWith("/chat/completions"),
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(
      "Name the flower in the attached note. Answer in one brief sentence.",
    );
  await page.getByTestId("advanced-composer-send").click();
  const sent = await request;
  expect(sent.postData()).toContain(attachmentText.replaceAll("\n", "\\n"));
  expect(sent.postDataJSON().max_tokens).toBe(768);
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText(/marigold/i);
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toBeInViewport({ ratio: 0.9 });
  await expect(
    page.getByRole("button", { name: "Remove verification.txt", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("attachment-live-response.png"),
    fullPage: true,
  });

  await page
    .getByRole("button", { name: /^(Archives|Import & export)$/ })
    .first()
    .click();
  const zip = await download(
    page,
    "Export all chats as ZIP",
    testInfo.outputPath("chats-with-attachment.zip"),
  );
  const entries = await mobileArchiveZip.decode(zip);
  const manifest = JSON.parse(
    decoder.decode(
      entries.find((entry) => entry.path === "manifest.json")!.bytes,
    ),
  );
  expect(manifest.schema).toBe("locallab-chat-archive");
  expect(
    entries.some(
      (entry) =>
        entry.path.startsWith("assets/blobs/") &&
        decoder.decode(entry.bytes) === attachmentText,
    ),
  ).toBe(true);
  expect(
    entries.some(
      (entry) =>
        entry.path.startsWith("assets/attachments/") &&
        decoder.decode(entry.bytes).includes("verification.txt"),
    ),
  ).toBe(true);
  await choose(page, "Import ZIP archive", {
    name: "saved-chats.zip",
    mimeType: "application/zip",
    buffer: zip,
  });
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "AI Chat on My Terms", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^(Archives|Import & export)$/ })
    .first()
    .click();
  const reopened = await download(
    page,
    "Export all chats as ZIP",
    testInfo.outputPath("reopened-chats.zip"),
  );
  const reopenedEntries = await mobileArchiveZip.decode(reopened);
  const reopenedManifest = JSON.parse(
    decoder.decode(
      reopenedEntries.find((entry) => entry.path === "manifest.json")!.bytes,
    ),
  );
  expect(reopenedManifest.conversations.length).toBeGreaterThan(
    manifest.conversations.length,
  );
  expect(
    reopenedEntries.some(
      (entry) =>
        entry.path.startsWith("assets/blobs/") &&
        decoder.decode(entry.bytes) === attachmentText,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("archive-reopened.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("browser rejects malformed archives and retains an invalid UTF-8 original", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await startChat(page);
  await choose(page, "Attach", {
    name: "invalid-utf8.txt",
    mimeType: "text/plain",
    buffer: Buffer.from([0xc3, 0x28]),
  });
  await expect(
    page.getByRole("button", { name: "Remove invalid-utf8.txt", exact: true }),
  ).toBeVisible();
  const managedFileCount = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const request = indexedDB.open("locallab-managed-blobs");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const count = database
              .transaction("files", "readonly")
              .objectStore("files")
              .count();
            count.onsuccess = () => {
              database.close();
              resolve(count.result);
            };
            count.onerror = () => {
              database.close();
              reject(count.error);
            };
          };
        }),
    );
  // The "files" store backs the whole app filesystem on web (SQLite
  // database, journals, and the retained original as `locallab/blobs/...`
  // keys), so its absolute row count says nothing about this attachment.
  // The retained-original contract is asserted via the message below and
  // via the store shrinking again after Remove.
  const afterAttach = await managedFileCount();
  await expect(
    page.getByText(/original file is saved|original file is retained/i).first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("invalid-utf8-retained.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Remove invalid-utf8.txt", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove invalid-utf8.txt", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(managedFileCount)
    .toBeLessThan(afterAttach); /* Remove frees the retained blob */
  await openArchives(page);
  const originalPdf = await download(
    page,
    "Export chat as PDF",
    testInfo.outputPath("document-original.pdf"),
  );
  await page
    .getByRole("button", {
      name: /^(Return to (conversation|chat)|Back to chat)$/,
    })
    .first()
    .click();
  await choose(page, "Attach", {
    name: "document-original.pdf",
    mimeType: "application/pdf",
    buffer: originalPdf,
  });
  await expect(
    page.getByRole("button", {
      name: "Remove document-original.pdf",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByText(/PDF text extraction is unavailable in this browser build/i)
      .first(),
  ).toBeVisible();
  const afterPdf = await managedFileCount();
  await page.screenshot({
    path: testInfo.outputPath("pdf-extraction-unavailable.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Remove document-original.pdf", exact: true })
    .click();
  await expect
    .poll(managedFileCount)
    .toBeLessThan(afterPdf); /* Remove frees the PDF blob */
  await openArchives(page);
  await choose(page, "Import LM Studio export", {
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("not valid JSON"),
  });
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Selected LM Studio export is not valid JSON" }),
  ).toBeVisible();
  await choose(page, "Import ZIP archive", {
    name: "invalid.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("not a ZIP file"),
  });
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "ZIP is malformed or unreadable" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("invalid-archive-error.png"),
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: "Export all chats as ZIP", exact: true }),
  ).toBeEnabled();
  const zip = await download(
    page,
    "Export all chats as ZIP",
    testInfo.outputPath("after-rejected-import.zip"),
  );
  const entries = await mobileArchiveZip.decode(zip);
  const manifest = JSON.parse(
    decoder.decode(
      entries.find((entry) => entry.path === "manifest.json")!.bytes,
    ),
  );
  expect(manifest.conversations).toHaveLength(1);
  expect(manifest.conversations[0].messages).toEqual([]);
  expect(errors).toEqual([]);
});
