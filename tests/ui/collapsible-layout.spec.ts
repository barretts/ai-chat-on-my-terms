import { test, expect, type Page } from "@playwright/test";

const response =
  "## A useful phone conversation\n\n" +
  "You should be able to read this answer while writing your next message. Settings belong in a menu, and message tools should be available when you need them.\n\n".repeat(
    6,
  );
const safeAreaStyle =
  '[data-testid="app-safe-area"], [data-testid="phone-navigation-safe-area"] { padding-top: 62px !important; padding-bottom: 34px !important; }';
async function settleDialog(page: Page, id: string) {
  await expect
    .poll(() =>
      page
        .getByTestId(`${id}-surface`)
        .evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBe(1);
}

for (const size of [
  { width: 440, height: 956 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`Paper phone chat is usable by default at ${size.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let holdReply = false;
    let releaseReply = () => {};
    await page.route("https://phone-ui-fixture.example/**", async (route) => {
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "content-type": "application/json",
      };
      if (route.request().method() === "OPTIONS")
        return route.fulfill({ status: 204, headers });
      if (route.request().url().endsWith("/models"))
        return route.fulfill({
          status: 200,
          headers,
          json: { data: [{ id: "phone-fixture" }] },
        });
      if (holdReply)
        await new Promise<void>((resolve) => {
          releaseReply = resolve;
        });
      await route
        .fulfill({
          status: 200,
          headers: { ...headers, "content-type": "text/event-stream" },
          body: `data: ${JSON.stringify({ choices: [{ delta: { content: response }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
        })
        .catch(() => {});
    });
    const button = (name: string) =>
      page.getByRole("button", { name, exact: true });
    await page.goto("/");
    if (size.width === 440) await page.addStyleTag({ content: safeAreaStyle });
    await button("Continue without a model").click();
    await page
      .getByRole("button", { name: "Choose chat connection" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Your connections", exact: true }),
    ).toBeVisible();
    await button("Add provider").click();
    const other = button("Other");
    if (await other.count()) await other.click();
    await page
      .getByRole("textbox", { name: "Provider name", exact: true })
      .fill("Barrett's PC");
    await page
      .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
      .fill("https://phone-ui-fixture.example/v1");
    await button("Load endpoint models").click();
    await expect(page.getByText(/Found 1 models/)).toBeVisible();
    await button("Save and use provider").click();
    await expect(page.getByText("Barrett's PC", { exact: true })).toBeVisible();
    await expect(
      page.getByText("AI Chat Messenger", { exact: true }),
    ).toHaveCount(0);
    const transcript = page.getByTestId("chat-transcript-scroll");
    const area = await transcript.boundingBox();
    expect(area!.height / size.height).toBeGreaterThan(0.7);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Help me use models and voices on my phone.");
    await page.getByTestId("advanced-composer-send").click();
    await expect(
      page.getByText("Response complete", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `${testInfo.outputDir}/paper-phone.png` });
    for (const target of [
      button("Open chat menu"),
      button("Open chat history"),
      button("Start a new chat"),
      button("Show message tools"),
      button("Read response aloud"),
    ]) {
      const box = await target.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await button("Show message tools").click();
    await settleDialog(page, "message-tools");
    await page.getByRole("switch", { name: "Web search", exact: true }).click();
    await button("Close message tools").click();
    await page.getByTestId("message-tools").waitFor({ state: "hidden" });
    expect((await transcript.boundingBox())!.height).toBe(area!.height);
    await button("Show message tools").click();
    await expect(
      page.getByRole("switch", { name: "Web search", exact: true }),
    ).toBeChecked();
    await page.getByRole("switch", { name: "Web search", exact: true }).click();
    await button("Close message tools").click();
    await button("Open chat menu").click();
    await settleDialog(page, "chat-menu");
    await expect(button("Connections")).toBeVisible();
    await button("Settings").click();
    await expect(button("Return to conversation")).toBeVisible();
    const systemPrompt = page.getByRole("textbox", {
      name: "System prompt",
      exact: true,
    });
    await expect(systemPrompt).toHaveCount(0);
    await expect(
      page.getByRole("tab", { name: "Global", exact: true }),
    ).toHaveCount(0);
    await button("Model instructions").click();
    await expect(systemPrompt).toBeVisible();
    await button("Model instructions").click();
    await expect(systemPrompt).toHaveCount(0);
    await button("Settings scope").click();
    await expect(
      page.getByRole("tab", { name: "This chat", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await button("Return to conversation").click();
    await button("Open chat menu").click();
    await settleDialog(page, "chat-menu");
    await button("Dark").click();
    await button("Close chat menu").click();
    await page.getByTestId("chat-menu").waitFor({ state: "hidden" });
    const background = await page
      .getByTestId("app-safe-area")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.reload();
    if (size.width === 440) await page.addStyleTag({ content: safeAreaStyle });
    await expect
      .poll(() =>
        page
          .getByTestId("app-safe-area")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe(background);
    await expect(page.getByTestId("chat-menu")).toHaveCount(0);
    await expect(page.getByTestId("message-tools")).toHaveCount(0);
    if (size.width === 440)
      await page.setViewportSize({ width: 440, height: 600 });
    await message.fill(
      "Write my next reply while I can still see the conversation.",
    );
    const send = await page.getByTestId("advanced-composer-send").boundingBox();
    expect(send!.y + send!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height - (size.width === 440 ? 34 : 0),
    );
    expect(send!.height).toBeGreaterThanOrEqual(44);
    holdReply = true;
    await page.getByTestId("advanced-composer-send").click();
    await expect(page.getByTestId("advanced-composer-stop")).toBeVisible();
    await page.getByTestId("advanced-composer-stop").click();
    releaseReply();
    await expect(
      page.getByText("Response stopped", { exact: true }),
    ).toBeVisible();
    await button("Open chat history").click();
    await expect(
      page.getByRole("button", { name: "Recent", exact: true }),
    ).toBeVisible();
    await button("Return to conversation").click();
    await button("Start a new chat").click();
    await expect(page.getByTestId("assistant-response-text")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("desktop focus controls still persist", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  const transcript = page.getByTestId("chat-transcript-scroll");
  const before = await transcript.boundingBox();
  await page
    .getByRole("button", { name: "Focus conversation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Show all controls", exact: true }),
  ).toBeVisible();
  expect(
    (await transcript.boundingBox())!.height - before!.height,
  ).toBeGreaterThan(100);
  await page
    .getByRole("button", { name: "Show chat controls", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Providers", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Hide chat controls", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Show all controls", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Show all controls", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show all controls", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Providers", exact: true }),
  ).toBeVisible();
});
