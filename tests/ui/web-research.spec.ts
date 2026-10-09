import { test, expect } from "@playwright/test";

test("web switches retrieve evidence, save clickable sources, and show recoverable failures", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  const webRequests: string[] = [];
  let failSearch = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://web-model-fixture.example/**", async (route) => {
    const headers = {
      "access-control-allow-origin": new URL(page.url()).origin,
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "content-type": "application/json",
    };
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (route.request().url().endsWith("/models"))
      return route.fulfill({
        status: 200,
        headers,
        json: { data: [{ id: "web-fixture" }] },
      });
    modelRequests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      headers: { ...headers, "content-type": "text/event-stream" },
      body: 'data: {"choices":[{"delta":{"content":"Evidence received and used."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    });
  });
  await page.route("**/_locallab/web?**", async (route) => {
    const target = new URL(route.request().url()).searchParams.get("url")!;
    webRequests.push(target);
    expect(route.request().headers().authorization).toBeUndefined();
    if (target.includes("duckduckgo")) {
      if (failSearch)
        return route.fulfill({ status: 429, body: "Rate limited" });
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<a class="result__a" href="https://docs.expo.dev/">Expo reference</a><a class="result__snippet">Verified search snippet.</a>',
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "Title: Expo reference\nMarkdown Content:\nPage evidence from the reader fixture.",
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open chat menu", exact: true })
    .click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Web fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill("https://web-model-fixture.example/v1");
  await page
    .getByRole("button", { name: "Load endpoint models", exact: true })
    .click();
  await expect(page.getByText(/Found 1 models/)).toBeVisible();
  await page
    .getByRole("button", { name: "Save and use provider", exact: true })
    .click();
  const search = page.getByRole("switch", { name: "Web search", exact: true });
  const fetchPages = page.getByRole("switch", {
    name: "Read linked pages",
    exact: true,
  });
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await page
    .getByRole("button", { name: "Show message tools", exact: true })
    .click();
  await expect(search).not.toBeChecked();
  await expect(fetchPages).not.toBeChecked();
  await search.click();
  await fetchPages.click();
  await page
    .getByRole("button", { name: "Close message tools", exact: true })
    .click();
  await message.fill("Find the Expo reference");
  await page.getByTestId("advanced-composer-send").click();
  await expect(page.getByTestId("assistant-response-text")).toHaveAttribute(
    "aria-label",
    "Evidence received and used.",
  );
  expect(JSON.stringify(modelRequests[0])).toContain(
    "Page evidence from the reader fixture",
  );
  expect(webRequests).toHaveLength(2);
  await page.getByRole("button", { name: "Show sources", exact: true }).click();
  await expect(
    page.getByRole("link", {
      name: "Open source: Expo reference",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/web-research.png`,
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "Show sources", exact: true }).click();
  await expect(
    page.getByRole("link", {
      name: "Open source: Expo reference",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show message tools", exact: true })
    .click();
  await expect(search).not.toBeChecked();
  await expect(fetchPages).not.toBeChecked();

  await fetchPages.click();
  await page
    .getByRole("button", { name: "Close message tools", exact: true })
    .click();
  await message.fill("Read this page https://docs.expo.dev/");
  await page.getByTestId("advanced-composer-send").click();
  await expect(page.getByTestId("assistant-response-text")).toHaveCount(2);
  expect(webRequests).toHaveLength(3);
  expect(webRequests[2]).toContain("r.jina.ai");
  expect(modelRequests).toHaveLength(2);
  await page
    .getByRole("button", { name: "Show message tools", exact: true })
    .click();
  await fetchPages.click();
  await search.click();
  await page
    .getByRole("button", { name: "Close message tools", exact: true })
    .click();
  failSearch = true;
  await message.fill("Trigger a search service failure");
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText(/web service is busy or rate limited/).first(),
  ).toBeVisible();
  await expect(page.getByTestId("advanced-composer-send")).toBeVisible();
  expect(modelRequests).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("web controls keep Send inside a short phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  const send = await page.getByTestId("advanced-composer-send").boundingBox();
  expect(send).not.toBeNull();
  expect(send!.y + send!.height).toBeLessThanOrEqual(568);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Show message tools", exact: true })
    .click();
  await expect(
    page.getByRole("switch", { name: "Web search", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Writing options", exact: true })
    .click();
  await expect(
    page.getByText(
      /Web search sends this message to your selected search service/,
    ),
  ).toBeVisible();
  const done = await page
    .getByRole("button", { name: "Done with writing options", exact: true })
    .boundingBox();
  expect(done!.y).toBeGreaterThanOrEqual(0);
  expect(done!.y + done!.height).toBeLessThanOrEqual(568);
});
