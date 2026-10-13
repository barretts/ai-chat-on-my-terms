import { readFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

const content =
  '# Launch plan 🌻\n\n<persona voice="calm">日本語 & markdown</persona>\n\n## Checklist\n\n- Preview the document\n- Save it to Files\n\n```typescript\nconst label = `Hello 🌻`;\n```\n';
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });

async function setup(page: Page, testInfo: TestInfo, nativeTools: boolean) {
  await page.setViewportSize({ width: 440, height: 956 });
  const origin = nativeTools
    ? "https://native-files-fixture.example"
    : "https://text-files-fixture.example";
  const modelId = nativeTools ? "ninfer-files-model" : "text-files-model";
  const requests: Array<{
    tools?: Array<{ function: { name: string } }>;
    messages: Array<Record<string, unknown>>;
    max_tokens?: number;
    enable_thinking?: boolean;
  }> = [];
  const runtimeErrors: string[] = [];
  const blockedOrigins: string[] = [];
  page.on("pageerror", (cause) => runtimeErrors.push(cause.message));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const localOrigin = new URL(testInfo.project.use.baseURL as string).origin;
    if (["data:", "blob:"].includes(url.protocol) || url.origin === localOrigin)
      return route.continue();
    if (url.origin !== origin) {
      blockedOrigins.push(url.origin);
      return route.abort();
    }
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "content-type": "application/json",
    };
    if (req.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (url.pathname === "/v1/models")
      return route.fulfill({
        headers,
        json: {
          data: [
            {
              id: modelId,
              max_model_len: 65_536,
              ...(nativeTools ? { owned_by: "ninfer" } : {}),
            },
          ],
        },
      });
    expect(url.pathname).toBe("/v1/chat/completions");
    const body = req.postDataJSON();
    requests.push(body);
    const chunks: unknown[] = [];
    if (nativeTools && requests.length === 1) {
      const args = JSON.stringify({ path: "notes/plan.md", content });
      chunks.push({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-files-1",
                  type: "function",
                  function: {
                    name: "workspace_write_file",
                    arguments: args.slice(0, 48),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      chunks.push({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: args.slice(48) } },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      chunks.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      const reply = nativeTools
        ? "Saved notes/plan.md in Files."
        : `\`\`\`markdown\n${content}\`\`\`\n`;
      const split = reply.indexOf("🌻") + 1;
      chunks.push({
        choices: [
          { delta: { content: reply.slice(0, split) }, finish_reason: null },
        ],
      });
      chunks.push({
        choices: [
          { delta: { content: reply.slice(split) }, finish_reason: null },
        ],
      });
      chunks.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
    }
    return route.fulfill({
      headers: { ...headers, "content-type": "text/event-stream" },
      body:
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
        "data: [DONE]\n\n",
    });
  });
  await page.goto("/");
  await button(page, "Continue without a model").click();
  await button(page, "Open chat menu").click();
  await button(page, "Connections").click();
  await button(page, "Other").click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill(nativeTools ? "Native file fixture" : "Text file fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill(`${origin}/v1`);
  await button(page, "Load endpoint models").click();
  await expect(page.getByText(/Found 1 models/)).toBeVisible();
  await button(page, "Save and use provider").click();
  return { requests, runtimeErrors, blockedOrigins };
}

async function openFiles(page: Page) {
  await button(page, "Open chat menu").click();
  await button(page, "Files").click();
  await expect(button(page, "Close chat menu")).toHaveCount(0);
  await expect(page.getByTestId("workspace-files-screen")).toBeVisible();
}

async function writeAndPreview(page: Page, testInfo: TestInfo) {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill(
    "Write notes/plan.md with a launch checklist, Unicode, XML and an internal code block.",
  );
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Response complete", { exact: true }).last(),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(message).toHaveValue("");
  await openFiles(page);
  const entry = page.getByRole("button", { name: /^Open notes\/plan\.md, / });
  await expect(entry).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-files-list.png`,
    fullPage: true,
  });
  await entry.click();
  await expect(
    page.getByLabel("Preview of notes/plan.md", { exact: true }),
  ).toContainText("Launch plan 🌻");
  await expect(
    page.getByLabel("Preview of notes/plan.md", { exact: true }),
  ).toContainText("日本語 & markdown");
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-file-preview.png`,
    fullPage: true,
  });
  await button(page, "View Markdown source").click();
  await expect(
    page.getByLabel("Source of notes/plan.md", { exact: true }),
  ).toHaveText(content);
  const fileDownloadPromise = page.waitForEvent("download");
  await button(page, "Export notes/plan.md").click();
  const fileDownload = await fileDownloadPromise;
  expect(fileDownload.suggestedFilename()).toBe("plan.md");
  const filePath = `${testInfo.outputDir}/exported-plan.md`;
  await fileDownload.saveAs(filePath);
  expect(await readFile(filePath, "utf8")).toBe(content);
  await button(page, "Back to chat files").click();
  const zipDownloadPromise = page.waitForEvent("download");
  await button(page, "Export all chat files as ZIP").click();
  const zipDownload = await zipDownloadPromise;
  expect(zipDownload.suggestedFilename()).toBe("locallab-workspace.zip");
  const zipPath = `${testInfo.outputDir}/exported-workspace.zip`;
  await zipDownload.saveAs(zipPath);
  const archive = unzipSync(new Uint8Array(await readFile(zipPath)));
  expect(Object.keys(archive)).toEqual(["notes/plan.md"]);
  expect(strFromU8(archive["notes/plan.md"]!)).toBe(content);
}

test("phone native file tools save, continue, preview, export and persist until the chat is deleted", async ({
  page,
}, testInfo) => {
  const fixture = await setup(page, testInfo, true);
  await writeAndPreview(page, testInfo);
  expect(fixture.requests).toHaveLength(2);
  expect(fixture.requests[0]!.tools!.map((tool) => tool.function.name)).toEqual([
    "workspace_list_files",
    "workspace_read_file",
    "workspace_write_file",
    "web_search",
    "web_fetch",
    "current_time",
  ]);
  expect(fixture.requests[0]!.max_tokens).toBe(2048);
  expect(fixture.requests[0]!.enable_thinking).toBe(false);
  const toolMessage = fixture.requests[1]!.messages.find(
    (message) => message.role === "tool",
  );
  expect(toolMessage).toMatchObject({
    tool_call_id: expect.any(String),
    content: expect.stringContaining('"saved":true'),
  });
  await page.reload();
  await expect(button(page, "Open chat menu")).toBeVisible();
  await openFiles(page);
  await expect(
    page.getByRole("button", { name: /^Open notes\/plan\.md, / }),
  ).toBeVisible();
  await button(page, "Return to conversation").click();
  await button(page, "Open chat history").click();
  const current = page
    .getByTestId(/^history-open-/)
    .filter({ hasText: "Open now" });
  await expect(current).toHaveCount(1);
  const currentId = (await current.getAttribute("data-testid"))!.replace(
    "history-open-",
    "",
  );
  await page.getByTestId(`history-more-${currentId}`).click();
  await page.getByRole("button", { name: /^Delete / }).click();
  await page.getByRole("button", { name: /^Delete .* for good$/ }).click();
  await expect(page.getByText(/^Deleted ".*"\.$/)).toBeVisible();
  await expect(page.getByTestId(`history-open-${currentId}`)).toHaveCount(0);
  await page.goto("/chat");
  await openFiles(page);
  await expect(
    page.getByText("Your chat's files will appear here.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Open notes\/plan\.md, / }),
  ).toHaveCount(0);
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-files-after-chat-delete.png`,
    fullPage: true,
  });
  expect(fixture.runtimeErrors).toEqual([]);
  expect(fixture.blockedOrigins).toEqual([]);
});

test("phone text-only models save complete documents and manual files can be created and edited", async ({
  page,
}, testInfo) => {
  const fixture = await setup(page, testInfo, false);
  await writeAndPreview(page, testInfo);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]!.tools).toBeUndefined();
  expect(fixture.requests[0]!.max_tokens).toBe(2048);
  expect(fixture.requests[0]).not.toHaveProperty("enable_thinking");
  await button(page, "Create a new chat file").click();
  await page
    .getByRole("textbox", { name: "Workspace filename", exact: true })
    .fill("notes/manual.txt");
  await page
    .getByRole("textbox", {
      name: "Complete workspace file content",
      exact: true,
    })
    .fill("Manual 🌻\n<xml />\n");
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-new-file-editor.png`,
    fullPage: true,
  });
  await button(page, "Save file in this chat").click();
  await expect(
    page.getByLabel("Source of notes/manual.txt", { exact: true }),
  ).toHaveText("Manual 🌻\n<xml />\n");
  await button(page, "Edit notes/manual.txt").click();
  await expect(
    page.getByRole("textbox", { name: "Workspace filename", exact: true }),
  ).not.toBeEditable();
  await page
    .getByRole("textbox", {
      name: "Complete workspace file content",
      exact: true,
    })
    .fill("Updated manual 🌻\n<xml />\n");
  await button(page, "Save file in this chat").click();
  await expect(
    page.getByLabel("Source of notes/manual.txt", { exact: true }),
  ).toHaveText("Updated manual 🌻\n<xml />\n");
  await expect(page.getByText(/Revision 2/)).toBeVisible();
  await page.reload();
  await openFiles(page);
  await expect(
    page.getByRole("button", {
      name: /^Open notes\/manual\.txt, .*revision 2$/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Open notes\/plan\.md, / }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-files-persisted.png`,
    fullPage: true,
  });
  expect(fixture.runtimeErrors).toEqual([]);
  expect(fixture.blockedOrigins).toEqual([]);
});
