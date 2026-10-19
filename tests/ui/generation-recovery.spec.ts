import { expect, test, type Page } from "@playwright/test";

const apiBase = process.env.LOCALLAB_LIVE_API_BASE;
const model = process.env.LOCALLAB_LIVE_MODEL ?? "local-coder";
test.beforeEach(() => {
  test.skip(
    !apiBase,
    "Set LOCALLAB_LIVE_API_BASE to exercise real streamed generation recovery.",
  );
});

async function showLatestReply(page: Page) {
  const latest = page.getByRole("button", {
    name: "Scroll to latest message",
    exact: true,
  });
  if (await latest.isVisible()) await latest.click();
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toBeInViewport({ ratio: 0.9 });
}

async function setup(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page.getByRole("button", { name: /^Choose dark theme/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "AI Chat on My Terms", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("tab", { name: "compatible", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Recovery local server");
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Maximum output tokens", exact: true })
    .fill("768");
  await page
    .getByRole("textbox", { name: "Maximum output tokens", exact: true })
    .press("Tab");
  await expect(
    page.getByText("Saving settings...", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

test("reload during a real streamed response preserves partial text and recovers the run", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page);
  const response = page.waitForResponse(
    (value) =>
      decodeURIComponent(value.url()).endsWith("/chat/completions") &&
      value.request().method() === "POST" &&
      value.status() === 200,
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Write 500 numbered programming tips with examples.");
  await page.getByTestId("advanced-composer-send").click();
  await response;
  const reasoning = page.locator('[aria-label^="Reasoning:"]');
  await expect
    .poll(
      async () =>
        (await reasoning.first().getAttribute("aria-label"))?.length ?? 0,
    )
    .toBeGreaterThan(80);
  const partial = (await reasoning.first().getAttribute("aria-label"))!.slice(
    "Reasoning: ".length,
    "Reasoning: ".length + 60,
  );
  await expect(
    page.getByText("Generating response", { exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("before-reload-running.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "AI Chat on My Terms", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Generating response", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Response stopped", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop response", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('[aria-label^="Reasoning:"]').first(),
  ).toHaveAttribute("aria-label", expect.stringContaining(partial));
  await page.screenshot({
    path: testInfo.outputPath("after-reload-recovered.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("<|think_off|>\nReply with one brief sentence.");
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .press("Tab");
  await expect(
    page.getByText("Saving settings...", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(
      "My preferred code editor is Helix. Acknowledge this durable preference in one brief sentence.",
    );
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText(/Helix/i);
  await showLatestReply(page);
  await page.screenshot({
    path: testInfo.outputPath("new-response-after-recovery.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByText("Response stopped", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("assistant-response-text").last(),
  ).toContainText(/Helix/i);
  await showLatestReply(page);
  expect(errors).toEqual([]);
});

test("another tab leaves a live generation untouched and recovers it after the owning tab closes", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await setup(page);
  const response = page.waitForResponse(
    (value) =>
      decodeURIComponent(value.url()).endsWith("/chat/completions") &&
      value.request().method() === "POST" &&
      value.status() === 200,
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Write 500 numbered programming tips with examples.");
  await page.getByTestId("advanced-composer-send").click();
  await response;
  const reasoning = page.locator('[aria-label^="Reasoning:"]');
  await expect
    .poll(
      async () =>
        (await reasoning.first().getAttribute("aria-label"))?.length ?? 0,
    )
    .toBeGreaterThan(80);
  const partial = (await reasoning.first().getAttribute("aria-label"))!.slice(
    "Reasoning: ".length,
    "Reasoning: ".length + 60,
  );
  const firstOwner = await page.evaluate(
    async () =>
      (await navigator.locks.query()).held?.find((lock) =>
        lock.name?.startsWith("locallab:mobile-chat:generation-owner:"),
      )?.name,
  );
  expect(firstOwner).toBeTruthy();
  const viewer = await page.context().newPage();
  await viewer.goto("/chat");
  await expect(viewer.getByRole("alert")).toContainText(
    /Another app tab.*database open/i,
  );
  await expect(
    page.getByText("Generating response", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Response stopped", { exact: true })).toHaveCount(
    0,
  );
  expect(
    await viewer.evaluate(
      async (name) =>
        (await navigator.locks.query()).held?.some(
          (lock) => lock.name === name,
        ),
      firstOwner,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("first-tab-live-run-preserved.png"),
    fullPage: true,
  });
  await viewer.screenshot({
    path: testInfo.outputPath("second-tab-storage-busy.png"),
    fullPage: true,
  });
  await page.close();
  await expect
    .poll(() =>
      viewer.evaluate(
        async (name) =>
          (await navigator.locks.query()).held?.some(
            (lock) => lock.name === name,
          ),
        firstOwner,
      ),
    )
    .toBe(false);
  await viewer
    .getByRole("button", { name: "Try opening chat again", exact: true })
    .click();
  await expect(
    viewer.getByRole("heading", { name: "AI Chat on My Terms", exact: true }),
  ).toBeVisible();
  await expect(
    viewer.getByText("Generating response", { exact: true }),
  ).toHaveCount(0);
  await expect(
    viewer.getByText("Response stopped", { exact: true }),
  ).toBeVisible();
  await expect(
    viewer.locator('[aria-label^="Reasoning:"]').first(),
  ).toHaveAttribute("aria-label", expect.stringContaining(partial));
  await expect(
    viewer.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  await viewer
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Continue this conversation.");
  await expect(viewer.getByTestId("advanced-composer-send")).toBeEnabled();
  await viewer.screenshot({
    path: testInfo.outputPath("second-tab-recovered-after-retry.png"),
    fullPage: true,
  });
});
