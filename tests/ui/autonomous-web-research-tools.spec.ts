import { expect, test } from "@playwright/test";

test("phone autonomous web tools search, read, answer and cite", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 956 });
  const endpoint = "https://autonomous-web-fixture.example/v1";
  const sourceUrl = "https://docs.expo.dev/";
  const sourceTitle = "Expo documentation";
  const sourceEvidence =
    "The autonomous Expo documentation fixture confirms the current SDK.";
  const requests: Array<{
    model: string;
    tools?: Array<{ function?: { name?: string } }>;
    messages: Array<{ role: string; content?: string }>;
  }> = [];
  const webRequests: Array<{ type: "search" | "fetch"; url: string }> = [];
  const runtimeErrors: string[] = [];
  let round = 0;
  page.on("pageerror", (cause) => runtimeErrors.push(cause.message));
  const toolCallBody = (name: string, args: unknown) =>
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call-${name}-${++round}`,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\ndata: [DONE]\n\n`;
  const textBody = (text: string) =>
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text }, finish_reason: null }],
    })}\n\ndata: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`;
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
        webRequests.push({ type: "search", url: target.toString() });
        return route.fulfill({
          contentType: "text/html",
          body: `<a class="result__a" href="${sourceUrl}">${sourceTitle}</a><a class="result__snippet">Current SDK documentation snippet.</a>`,
        });
      }
      expect(target.hostname).toBe("r.jina.ai");
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
    if (url.origin !== new URL(endpoint).origin) return route.abort();
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
        json: {
          data: [
            {
              id: "autonomous-web-model",
              max_model_len: 65_536,
              owned_by: "ninfer",
            },
          ],
        },
      });
    expect(url.pathname).toBe("/v1/chat/completions");
    const body = request.postDataJSON() as (typeof requests)[number];
    requests.push(body);
    let bodyText: string;
    if (requests.length === 1) {
      // The capable model decides to search on its own.
      bodyText = toolCallBody("web_search", { query: "current Expo SDK" });
    } else if (requests.length === 2) {
      expect(body.messages.some((message) => message.role === "tool")).toBe(
        true,
      );
      bodyText = toolCallBody("web_fetch", { url: sourceUrl });
    } else {
      bodyText = textBody("The current Expo SDK is confirmed by the docs.");
    }
    return route.fulfill({
      headers: { ...headers, "content-type": "text/event-stream" },
      body: bodyText,
    });
  });
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await page.goto("/");
  await button("Continue without a model").click();
  await button("Open chat menu").click();
  await button("Connections").click();
  const add = page.getByRole("button", { name: "Add provider" });
  const other = page.getByRole("button", { name: "Other", exact: true });
  // The first "Add provider" tap can land while the Connections panel is
  // still animating; re-tap until the editor with the preset row opens.
  await expect
    .poll(
      async () => {
        if (await other.isVisible().catch(() => false)) return true;
        if (await add.isVisible().catch(() => false))
          await add.click({ timeout: 2_000 }).catch(() => {});
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await other.click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Autonomous web fixture");
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill(endpoint);
  await button("Load endpoint models").click();
  await expect(page.getByText(/Found 1 models/)).toBeVisible();
  await button("Save and use provider").click();
  // "Save and use provider" leaves the editor open on both platforms;
  // return to the chat explicitly (web-research.spec.ts pattern).
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});
  for (let attempt = 0; attempt < 4; attempt++) {
    if (
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .isVisible()
        .catch(() => false)
    )
      break;
    const back = page
      .getByRole("button", {
        name: /^(Return to (conversation|chat)|Back to chat)$/,
      })
      .first();
    if (await back.isVisible().catch(() => false)) {
      await back.click({ timeout: 3000 }).catch(() => {});
      continue;
    }
    const rail = page
      .getByRole("button", { name: /^(Providers|Connections)$/ })
      .first();
    if (await rail.isVisible().catch(() => false)) {
      await rail.click({ timeout: 3000 }).catch(() => {});
      continue;
    }
    break;
  }
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByTestId("advanced-composer-send");

  // A plain current-information question, no chips and no web keywords.
  await message.fill("What is the current Expo SDK?");
  await send.click();
  await expect(page.getByTestId("assistant-response-text")).toHaveCount(1);
  await expect(
    page.getByText("Response complete", { exact: true }).last(),
  ).toBeVisible();
  expect(requests).toHaveLength(3);
  // Tools were advertised without requiring search words or chips.
  expect(
    (requests[0].tools ?? []).map((tool) => tool.function?.name),
  ).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
  expect(webRequests.map((item) => item.type)).toEqual(["search", "fetch"]);
  // The search result reached the model as a tool message before the read.
  expect(JSON.stringify(requests[1].messages)).toContain(sourceUrl);
  expect(JSON.stringify(requests[2].messages)).toContain(sourceEvidence);
  await button("Show sources").click();
  await expect(
    page.getByRole("link", {
      name: `Open source: ${sourceTitle}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-autonomous-web-tools.png`,
    fullPage: true,
  });

  // A follow-up answer needs no fresh information: zero research requests.
  const webBefore = webRequests.length;
  await message.fill("What did the docs say about the SDK?");
  await send.click();
  await expect(page.getByTestId("assistant-response-text")).toHaveCount(2);
  await expect(
    page.getByText("Response complete", { exact: true }).last(),
  ).toBeVisible();
  expect(webRequests).toHaveLength(webBefore);
  expect(runtimeErrors).toEqual([]);
});
