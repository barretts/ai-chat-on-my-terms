import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { mobileArchiveZip } from "../../apps/mobile/composition/chat/archives/zip";

const decoder = new TextDecoder();
const shortenedNotice =
  "Attachment text was shortened to fit this message. Original files remain saved.";

async function startChat(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "LocalLab Chat", exact: true }),
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
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("tab", { name: "compatible", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Attachment boundary fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill("https://attachment-boundary-fixture.test/v1");
  await page
    .getByRole("textbox", { name: "Exact chat model ID", exact: true })
    .fill("attachment-boundary");
  await page
    .getByRole("button", { name: "Save and use provider", exact: true })
    .click();
  return requests;
}

async function choose(
  page: Page,
  button: string,
  name: string,
  mimeType: string,
  bytes: Buffer,
) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: button, exact: true }).click();
  await (await chooser).setFiles({ name, mimeType, buffer: bytes });
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
  await page.getByRole("button", { name: "Archives", exact: true }).click();
  const entries = await mobileArchiveZip.decode(
    await download(page, "Export all chats as ZIP", path),
  );
  const manifest = JSON.parse(
    decoder.decode(
      entries.find((entry) => entry.path === "manifest.json")!.bytes,
    ),
  );
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
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
  const pendingChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  const chooser = await pendingChooser;
  // Exercise the actual transient chooser input's cancel notification. Physical OS Escape is separate.
  await chooser
    .element()
    .evaluate((input) => input.dispatchEvent(new Event("cancel")));
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  const context = page.getByRole("textbox", {
    name: "Context window",
    exact: true,
  });
  await context.fill("32768");
  await context.press("Tab");
  await expect(
    page.getByText("Saving settings...", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
  await expect(
    page.getByRole("heading", { name: "LocalLab Chat", exact: true }),
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
  await page.getByRole("button", { name: "New chat", exact: true }).click();
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
  await page.getByRole("button", { name: "Archives", exact: true }).click();
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
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText("FINAL_ASSISTANT_END");
  await page.getByRole("button", { name: "Archives", exact: true }).click();
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
