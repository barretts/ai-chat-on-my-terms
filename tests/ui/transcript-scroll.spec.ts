import { expect, test, type Page } from "@playwright/test";

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

test("hydrated transcript follows the latest reply and preserves manual reading through layout changes", async ({
  page,
}, testInfo) => {
  // These are explicitly imported archive fixtures, with no generated or intercepted provider reply.
  const latestText = "Visible latest imported answer marker.";
  const archive = {
    version: 1,
    conversations: [
      {
        id: "scroll-fixture",
        title: "Transcript scroll fixture",
        messages: [
          {
            id: "question-one",
            role: "user",
            content: Array.from(
              { length: 60 },
              (_, index) =>
                `Earlier question line ${index + 1}: preserve this reading position.`,
            ).join("\n"),
          },
          {
            id: "answer-one",
            role: "assistant",
            content: Array.from(
              { length: 35 },
              (_, index) => `Earlier imported answer line ${index + 1}.`,
            ).join("\n"),
          },
          {
            id: "question-two",
            role: "user",
            content: "The final imported question.",
          },
          { id: "answer-two", role: "assistant", content: latestText },
        ],
      },
    ],
  };
  await page.goto("/");
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
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Import LM Studio export", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "transcript-scroll-fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  await page
    .getByRole("button", {
      name: /^(Return to (conversation|chat)|Back to chat)$/,
    })
    .first()
    .click();
  const openFixture = page.getByRole("button", {
    name: "Open Transcript scroll fixture",
    exact: true,
  });
  if (!(await openFixture.isVisible().catch(() => false))) {
    const menu = page.getByRole("button", {
      name: "Open chat menu",
      exact: true,
    });
    if (await menu.count()) await menu.click();
    await page.getByRole("button", { name: "Library", exact: true }).click();
  }
  await openFixture.click();
  const primary = page.getByTestId("assistant-response-text").last();
  await expect(primary).toContainText(latestText);
  await expect(primary).toBeInViewport({ ratio: 0.9 });
  await page.reload();
  await expect(primary).toBeInViewport({ ratio: 0.9 });
  const transcript = page.getByTestId("chat-transcript-scroll");
  const original = await transcript.evaluate((element) => ({
    offset: element.scrollTop,
    viewport: element.clientHeight,
  }));
  expect(original.offset).toBeGreaterThan(500);
  await transcript.hover();
  await page.mouse.wheel(0, -800);
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeLessThan(original.offset - 300);
  const latest = page.getByRole("button", {
    name: "Scroll to latest message",
    exact: true,
  });
  await expect(latest).toBeVisible();
  const readingOffset = await transcript.evaluate(
    (element) => element.scrollTop,
  );
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ ...viewport, height: viewport.height + 80 });
  await expect
    .poll(() => transcript.evaluate((element) => element.clientHeight))
    .toBeGreaterThan(original.viewport + 50);
  await expect
    .poll(async () =>
      Math.abs(
        (await transcript.evaluate((element) => element.scrollTop)) -
          readingOffset,
      ),
    )
    .toBeLessThan(3);
  await expect(primary).not.toBeInViewport();
  await latest.click();
  await expect(primary).toBeInViewport({ ratio: 0.9 });
  await expect(latest).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("latest-after-manual-reading.png"),
    fullPage: true,
  });
});
