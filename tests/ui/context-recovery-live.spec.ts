import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const apiBase = process.env.LOCALLAB_LIVE_API_BASE;
const model = process.env.LOCALLAB_LIVE_MODEL ?? "local-coder";

test("real context compaction changes only the request projection and retries the saved user turn", async ({
  page,
}, testInfo) => {
  test.skip(
    !apiBase,
    "Set LOCALLAB_LIVE_API_BASE to exercise the real server.",
  );
  test.setTimeout(180_000);
  const errors: string[] = [];
  const requests: Array<{
    model: string;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const target =
      new URL(request.url()).searchParams.get("url") ?? request.url();
    if (request.method() === "POST" && target.endsWith("/chat/completions")) {
      requests.push(request.postDataJSON());
    }
  });
  const oldest = `EARLIEST_KEEP_ANCHOR\n${"The original project uses Python and its source must stay saved. ".repeat(38)}`;
  const middle = `MIDDLE_SAVED_ANCHOR\n${"This is middle history retained in the original archive. ".repeat(35)}`;
  const recent = `LATEST_KEEP_ANCHOR\n${"The recent project work uses the Helix editor. ".repeat(20)}`;
  const archive = {
    version: 1,
    conversations: [
      {
        id: "context-projection-fixture",
        title: "Context projection validation",
        messages: [
          { id: "old-user", role: "user", content: oldest },
          {
            id: "old-answer",
            role: "assistant",
            content: "The original project is saved.",
          },
          { id: "middle-user", role: "user", content: middle },
          {
            id: "middle-answer",
            role: "assistant",
            content: "MIDDLE_RESPONSE_ANCHOR ".repeat(100),
          },
          { id: "recent-user", role: "user", content: recent },
          {
            id: "recent-answer",
            role: "assistant",
            content: "The recent work is saved.",
          },
        ],
      },
    ],
  };
  await page.goto("/");
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page.getByRole("button", { name: /^Choose dark theme/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "AI Chat on My Terms", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Archives", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Import LM Studio export", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "context-projection-fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText("The recent work is saved.");
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("tab", { name: "compatible", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Context validation local server");
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
  const connectionStatus = page.getByText(`Connected: ${model} is available.`, {
    exact: true,
  });
  await expect(connectionStatus).toBeVisible();
  await page
    .getByRole("textbox", { name: "Exact chat model ID", exact: true })
    .fill("model-not-in-inventory");
  await expect(connectionStatus).toHaveCount(0);
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("model-not-in-inventory");
  await page
    .getByRole("textbox", { name: "Exact chat model ID", exact: true })
    .fill(model);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(connectionStatus).toBeVisible();
  await page
    .getByRole("button", { name: "Save and use provider", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("<|think_off|>\nReply in one brief sentence.");
  await page
    .getByRole("textbox", { name: "Maximum output tokens", exact: true })
    .fill("256");
  await page
    .getByRole("textbox", { name: "Context window", exact: true })
    .fill("1024");
  await page
    .getByRole("heading", { name: "Chat and model settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const prompt =
    "FINAL_RETRY_ANCHOR: My editor is Helix. Acknowledge it in one brief sentence.";
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(prompt);
  await page.getByTestId("advanced-composer-send").click();
  const finalReply = page.getByTestId("assistant-response-text").last();
  await expect(finalReply).toContainText(/Helix/i, { timeout: 90_000 });
  await expect(page.getByTestId("advanced-composer-stop")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEditable();
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe(model);
  const rollText = JSON.stringify(requests[0].messages);
  expect(rollText).not.toContain("EARLIEST_KEEP_ANCHOR");
  expect(rollText).toContain("LATEST_KEEP_ANCHOR");
  expect(rollText).toContain("FINAL_RETRY_ANCHOR");
  await expect(
    page.getByText(/input tokens\s+-\s+[1-9]\d* messages omitted/),
  ).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Cut middle", exact: true }).click();
  await page
    .getByRole("button", { name: "Compact and retry", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Chat and model settings", exact: true }),
  ).toHaveCount(0);
  await expect(finalReply).toContainText(/Helix/i, { timeout: 90_000 });
  await expect(page.getByTestId("advanced-composer-stop")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEditable();
  expect(requests).toHaveLength(2);
  const cutText = JSON.stringify(requests[1].messages);
  expect(cutText).toContain("EARLIEST_KEEP_ANCHOR");
  expect(cutText).toContain("FINAL_RETRY_ANCHOR");
  expect(cutText).not.toContain("MIDDLE_RESPONSE_ANCHOR");
  expect(
    requests[1].messages.filter(
      (message) => message.role === "user" && message.content === prompt,
    ),
  ).toHaveLength(1);
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
  await expect(finalReply).toBeInViewport({ ratio: 0.9 });
  await page.screenshot({
    path: testInfo.outputPath("real-compacted-retry.png"),
    fullPage: true,
  });

  await page.reload();
  await expect(finalReply).toContainText(/Helix/i);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Cut middle", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Save context policy", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Retry request", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Archives", exact: true }).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export chat as TXT", exact: true })
    .click();
  const exported = await download;
  const path = testInfo.outputPath("original-history-after-compaction.txt");
  await exported.saveAs(path);
  const text = await readFile(path, "utf8");
  for (const retained of [oldest, middle, recent, prompt])
    expect(text).toContain(retained);
  expect(text.match(/FINAL_RETRY_ANCHOR/g)).toHaveLength(1);
  expect(errors).toEqual([]);
  await testInfo.attach("actual-compaction-requests", {
    body: JSON.stringify(requests, null, 2),
    contentType: "application/json",
  });
});
