import { expect, test } from "@playwright/test";

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
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page.getByRole("button", { name: /^Choose dark theme/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "LocalLab Chat", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Archives", exact: true }).click();
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
