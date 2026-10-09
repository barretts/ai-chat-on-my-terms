import { expect, test } from "@playwright/test";

test("phone follows natural web requests, reuses a follow-up topic, reads links and preserves failed drafts", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 956 });
  const endpoint = "https://automatic-web-fixture.example/v1";
  const sourceUrl = "https://docs.expo.dev/";
  const sourceTitle = "Expo documentation";
  const sourceEvidence =
    "The current Expo documentation fixture confirms the SDK details.";
  const requests: Array<{
    model: string;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const webRequests: Array<{
    type: "search" | "fetch";
    query?: string;
    url: string;
  }> = [];
  const runtimeErrors: string[] = [];
  const blockedOrigins: string[] = [];
  let failSearch = false;
  page.on("pageerror", (cause) => runtimeErrors.push(cause.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const localOrigin = new URL(testInfo.project.use.baseURL as string).origin;
    if (["data:", "blob:"].includes(url.protocol)) return route.continue();
    if (url.origin === localOrigin) {
      if (url.pathname !== "/_locallab/web") return route.continue();
      expect(request.headers().authorization).toBeUndefined();
      expect(request.headers()["x-subscription-token"]).toBeUndefined();
      const target = new URL(url.searchParams.get("url")!);
      if (
        ["html.duckduckgo.com", "lite.duckduckgo.com"].includes(target.hostname)
      ) {
        webRequests.push({
          type: "search",
          query: target.searchParams.get("q")!,
          url: target.toString(),
        });
        if (failSearch)
          return route.fulfill({
            status: 429,
            contentType: "application/json",
            body: '{"error":"Search quota reached","requestId":"COMPLETE-WEB-FAILURE-TAIL"}',
          });
        return route.fulfill({
          contentType: "text/html",
          body: `<a class="result__a" href="${sourceUrl}">${sourceTitle}</a><a class="result__snippet">Useful current documentation snippet.</a>`,
        });
      }
      expect(target.hostname).toBe("r.jina.ai");
      expect(target.pathname).toBe(`/${sourceUrl}`);
      webRequests.push({ type: "fetch", url: target.toString() });
      return route.fulfill({
        contentType: "application/json",
        json: {
          code: 200,
          data: {
            url: sourceUrl,
            title: sourceTitle,
            content: sourceEvidence,
            httpStatus: 200,
          },
        },
      });
    }
    if (url.origin !== new URL(endpoint).origin) {
      blockedOrigins.push(url.origin);
      return route.abort();
    }
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "content-type": "application/json",
    };
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (url.pathname === "/v1/models")
      return route.fulfill({
        headers,
        json: { data: [{ id: "automatic-web-model", max_model_len: 65_536 }] },
      });
    expect(url.pathname).toBe("/v1/chat/completions");
    expect(request.method()).toBe("POST");
    requests.push(request.postDataJSON());
    return route.fulfill({
      headers: { ...headers, "content-type": "text/event-stream" },
      body: 'data: {"choices":[{"delta":{"content":"The requested information arrived."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    });
  });
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await page.goto("/");
  await button("Continue without a model").click();
  await button("Open chat menu").click();
  await button("Connections").click();
  await button("Other").click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Automatic web fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill(endpoint);
  await button("Load endpoint models").click();
  await expect(page.getByText(/Found 1 models/)).toBeVisible();
  await button("Save and use provider").click();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByTestId("advanced-composer-send");
  const search = page.getByRole("switch", { name: "Web search", exact: true });
  const fetchPages = page.getByRole("switch", {
    name: "Read linked pages",
    exact: true,
  });
  await button("Show message tools").click();
  await expect(search).not.toBeChecked();
  await expect(fetchPages).not.toBeChecked();
  await button("Close message tools").click();

  const sendAndComplete = async (text: string, count: number) => {
    await message.fill(text);
    await send.click();
    await expect(page.getByTestId("assistant-response-text")).toHaveCount(
      count,
    );
    await expect(
      page.getByText("Response complete", { exact: true }).last(),
    ).toBeVisible();
    await expect(message).toHaveValue("");
    expect(requests).toHaveLength(count);
    expect(requests[count - 1].messages.at(-1)).toEqual({
      role: "user",
      content: text,
    });
  };
  const question = "What is Expo's current SDK? (check web)";
  await sendAndComplete(question, 1);
  expect(webRequests.map((item) => item.type)).toEqual(["search", "fetch"]);
  expect(webRequests[0].query).toBe("What is Expo's current SDK?");
  expect(JSON.stringify(requests[0].messages)).toContain(sourceEvidence);
  await button("Show sources").click();
  await expect(
    page.getByRole("link", {
      name: `Open source: ${sourceTitle}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-natural-web-request.png`,
    fullPage: true,
  });

  await sendAndComplete("check the web", 2);
  expect(webRequests.map((item) => item.type)).toEqual([
    "search",
    "fetch",
    "search",
    "fetch",
  ]);
  expect(webRequests[2].query).toBe("What is Expo's current SDK?");
  expect(JSON.stringify(requests[1].messages)).toContain(sourceEvidence);
  await sendAndComplete(`Summarize ${sourceUrl}`, 3);
  expect(webRequests).toHaveLength(5);
  expect(webRequests[4].type).toBe("fetch");

  // A deliberate offline request applies even when the manual switch is on.
  await button("Show message tools").click();
  await expect(search).not.toBeChecked();
  await search.click();
  await button("Close message tools").click();
  await sendAndComplete(
    "Answer offline. Explain web search without using the internet.",
    4,
  );
  expect(webRequests).toHaveLength(5);
  await button("Show message tools").click();
  await expect(search).toBeChecked();
  await button("Close message tools").click();

  failSearch = true;
  const preservedDraft = "Find refreshed Expo documentation (check web)";
  await message.fill(preservedDraft);
  await send.click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Generate response failed." });
  await expect(alert).toContainText("HTTP 429");
  await expect(alert).toContainText("COMPLETE-WEB-FAILURE-TAIL");
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(message).toHaveValue(preservedDraft);
  await expect(button("Copy error").first()).toBeVisible();
  await expect(button("Fix web research")).toBeVisible();
  expect(requests).toHaveLength(4);
  expect(webRequests).toHaveLength(6);
  expect(runtimeErrors).toEqual([]);
  expect(blockedOrigins).toEqual([]);
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-requested-web-failure.png`,
    fullPage: true,
  });
});
