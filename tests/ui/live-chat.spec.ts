import { expect, test } from "@playwright/test";

const apiBase = process.env.LOCALLAB_LIVE_API_BASE;
const model = process.env.LOCALLAB_LIVE_MODEL ?? "local-coder";

test("real local server setup, streamed reply, stop, reload and new chat", async ({
  page,
}, testInfo) => {
  test.skip(
    !apiBase,
    "Set LOCALLAB_LIVE_API_BASE to exercise a real local server.",
  );
  test.setTimeout(180_000);
  const errors: string[] = [];
  const requests: Array<{ url: string; body: any }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const raw = new URL(request.url());
    const target =
      raw.pathname === "/_locallab/provider"
        ? raw.searchParams.get("url")
        : request.url();
    if (target?.endsWith("/v1/chat/completions") && request.method() === "POST")
      requests.push({ url: target, body: request.postDataJSON() });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to AI Chat" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Choose power user setup/ }).click();
  await page.getByRole("button", { name: /Choose dark theme/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "AI Chat on My Terms", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^(Providers|Connections)$/ }).click();
  await page.getByRole("tab", { name: "compatible", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("OxCoder · llama.cpp");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill(apiBase!);
  await page
    .getByRole("textbox", { name: "Exact chat model ID", exact: true })
    .fill(model);
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Authorize this local HTTP origin before testing.",
  );
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
  await expect(
    page.getByText(`OxCoder · llama.cpp - ${model}`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // This loaded OxCoder template supports this flag; use the app's real system-prompt setting.
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("<|think_off|>\nReply with one brief sentence.");
  await page
    .getByRole("textbox", { name: "Maximum output tokens", exact: true })
    .fill("768");
  await page
    .getByRole("textbox", { name: "Context window", exact: true })
    .fill("16384");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const firstPrompt =
    "My preferred code editor is Helix. Acknowledge this preference in one brief sentence.";
  await message.fill(firstPrompt);
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("assistant-response-text")).toContainText(
    /Helix/i,
  );
  // The advanced engine permits one continuation when the server exhausts its output budget.
  expect(requests.length).toBeGreaterThanOrEqual(1);
  expect(requests.length).toBeLessThanOrEqual(2);
  for (const request of requests) {
    expect(request.body.model).toBe(model);
    expect(request.body.max_tokens).toBe(768);
  }
  expect(requests[0].url).toBe(
    `${apiBase!.replace(/\/$/, "")}/chat/completions`,
  );
  expect(requests[0].body.model).toBe(model);
  expect(requests[0].body.max_tokens).toBe(768);
  expect(requests[0].body.messages).toContainEqual({
    role: "user",
    content: firstPrompt,
  });
  await page.screenshot({
    path: `${testInfo.outputDir}/live-response.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("assistant-response-text")).toContainText(
    /Helix/i,
  );
  await expect(
    page.getByText(`OxCoder · llama.cpp - ${model}`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Maximum output tokens", exact: true }),
  ).toHaveValue("768");
  await expect(
    page.getByRole("textbox", { name: "Context window", exact: true }),
  ).toHaveValue("16384");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await message.fill(
    "Write a very long numbered list of programming tips, at least 500 items.",
  );
  const secondResponse = page.waitForResponse((response) => {
    const target =
      new URL(response.url()).searchParams.get("url") ?? response.url();
    return (
      target.endsWith("/v1/chat/completions") &&
      response.request().method() === "POST" &&
      response.status() === 200
    );
  });
  await page.getByTestId("advanced-composer-send").click();
  await secondResponse;
  await expect(page.getByTestId("advanced-composer-stop")).toBeVisible();
  await page.getByTestId("advanced-composer-stop").click();
  await expect(
    page.getByText("Response stopped", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("advanced-composer-send")).toBeVisible();
  await expect(message).toHaveValue("");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Retry request", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Chat and model settings" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("advanced-composer-stop")).toBeVisible();
  await page.getByTestId("advanced-composer-stop").click();
  await expect(page.getByText("Response stopped", { exact: true })).toHaveCount(
    2,
  );
  await expect(
    page.getByText(
      "Write a very long numbered list of programming tips, at least 500 items.",
      { exact: true },
    ),
  ).toHaveCount(1);
  await page.reload();
  await expect(page.getByText("Response stopped", { exact: true })).toHaveCount(
    2,
  );
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Response stopped", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText(`OxCoder · llama.cpp - ${model}`, { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(`OxCoder · llama.cpp - ${model}`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^(Providers|Connections)$/ }).click();
  await expect(
    page.getByRole("button", {
      name: `OxCoder · llama.cpp · ${model}`,
      exact: true,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await testInfo.attach("live-requests", {
    body: JSON.stringify(requests, null, 2),
    contentType: "application/json",
  });
});
