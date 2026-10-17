import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("phone shows and copies complete redacted HTTP and stream errors, then recovers after restart", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 956 });
  const endpoint = "https://full-response-fixture.example/v1";
  const key = "full-response-fixture-key-not-real";
  const label = "Full response fixture";
  const httpSentinel = "COMPLETE-HTTP-RESPONSE-END";
  const streamSentinel = "COMPLETE-STREAM-RESPONSE-END";
  const httpBody = JSON.stringify({
    failure: { reason: "request rejected", retryAfter: 15 },
    details: "H".repeat(12_000),
    echo: key,
    sentinel: httpSentinel,
  });
  const streamBody = JSON.stringify({
    error: {
      status: 503,
      reason: "stream capacity unavailable",
      details: "S".repeat(12_000),
    },
    echo: key,
    sentinel: streamSentinel,
  });
  const reply = "The server recovered and the saved draft was sent.";
  const runtimeErrors: string[] = [];
  const blockedOrigins: string[] = [];
  let posts = 0;
  page.on("pageerror", (cause) => runtimeErrors.push(cause.message));
  await page.addInitScript(() => {
    Object.assign(window, { fixtureCopiedFullError: "" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          Object.assign(window, { fixtureCopiedFullError: value });
        },
      },
    });
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      ["data:", "blob:"].includes(url.protocol) ||
      url.origin === new URL(testInfo.project.use.baseURL as string).origin
    )
      return route.continue();
    // The dev machine's seeded LM Studio provider (127.0.0.1:1234) probes on
    // load; let it through instead of recording it as a blocked origin
    // (same convention as automatic-context/automatic-web-research specs).
    if (url.origin === "http://127.0.0.1:1234") return route.continue();
    if (url.origin !== new URL(endpoint).origin) {
      blockedOrigins.push(url.origin);
      return route.abort();
    }
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "content-type": "application/json",
    };
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (url.pathname.includes("/models"))
      return route.fulfill({
        headers,
        json: { data: [{ id: "full-response-model" }] },
      });
    if (url.pathname.endsWith("/embeddings"))
      return route.fulfill({
        headers,
        json: { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] },
      });
    if (route.request().method() === "GET")
      return route.fulfill({ headers, json: { data: [] } });
    expect(route.request().headers().authorization).toBe(`Bearer ${key}`);
    expect(url.pathname).toBe("/v1/chat/completions");
    posts++;
    if (posts === 1)
      return route.fulfill({
        status: 422,
        headers: { ...headers, "content-type": "application/problem+json" },
        body: httpBody,
      });
    if (posts === 2)
      return route.fulfill({
        headers: { ...headers, "content-type": "text/event-stream" },
        body: `event: error\ndata: ${streamBody}\n\ndata: [DONE]\n\n`,
      });
    expect(JSON.stringify(route.request().postDataJSON())).toContain(
      "Preserved after restarting the app.",
    );
    return route.fulfill({
      headers: { ...headers, "content-type": "text/event-stream" },
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
    });
  });
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await page.goto("/");
  await button("Continue without a model").click();
  await page.goto("/chat?panel=diagnostics");
  await page
    .getByRole("switch", { name: "Record trace log", exact: true })
    .click();
  await expect(
    page.getByText("Trace recording is on. Reproduce the problem now.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/chat?panel=connections");
  const add = page.getByRole("button", { name: "Add provider" });
  const editor = page.getByRole("region", {
    name: "Provider connection editor",
  });
  // The panel's provider-list reload can close a freshly opened editor; retry.
  for (let attempt = 0; attempt < 4; attempt++) {
    await add.first().click();
    if (
      await editor
        .waitFor({ state: "visible", timeout: 2500 })
        .then(() => true)
        .catch(() => false)
    )
      break;
  }
  await expect(editor).toBeVisible();
  const other = button("Other");
  if (await other.count()) await other.click();
  const providerName = page.getByRole("textbox", {
    name: "Provider name",
    exact: true,
  });
  if (!(await providerName.count())) {
    const fold = button("Connection settings");
    if (await fold.count()) await fold.click();
  }
  await providerName.waitFor({ state: "visible" });
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill(label);
  await page
    .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
    .fill(endpoint);
  await page
    .getByRole("textbox", { name: "Provider API key", exact: true })
    .fill(key);
  await button("Load endpoint models").click();
  await expect(page.getByText(/Found 1 models/)).toBeVisible();
  const save = button("Save and use provider");
  if (!(await save.first().isVisible().catch(() => false))) {
    const more = button("More actions");
    if (await more.count()) await more.click();
  }
  await save.first().click();
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
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByTestId("advanced-composer-send");
  const verifyAndCopy = async (
    body: string,
    sentinel: string,
    photo: string,
  ) => {
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "Generate response failed." });
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText(sentinel);
    await expect(alert).not.toContainText(key);
    const details = page.getByLabel("Error details", { exact: true });
    await expect
      .poll(() => details.evaluate((element) => element.scrollTop))
      .toBe(0);
    const detailsBounds = await details.boundingBox();
    const headingTop = await alert.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    expect(detailsBounds).not.toBeNull();
    expect(Math.abs(headingTop - detailsBounds!.y)).toBeLessThan(2);
    expect(headingTop).toBeGreaterThanOrEqual(0);
    expect(headingTop + 24).toBeLessThanOrEqual(956);
    await expect(page.getByText("Error copied.", { exact: true })).toHaveCount(
      0,
    );
    expect(await alert.textContent()).toContain(
      body.replaceAll(key, "[REDACTED]"),
    );
    // Scope to the filtered card: the transcript keeps compact summary
    // notices (own Copy buttons) that a page-level locator would collide with.
    const copy = alert.locator(
      "xpath=following::button[contains(., 'Copy error')][1]",
    );
    await expect(copy).toBeVisible();
    const bounds = await copy.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(956);
    expect(
      await copy.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        return !!hit && (element === hit || element.contains(hit));
      }),
    ).toBe(true);
    await copy.click();
    await expect(
      page.getByText("Error copied.", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => Reflect.get(window, "fixtureCopiedFullError") as string,
        ),
      )
      .toBe(await alert.textContent());
    const copied = await page.evaluate(
      () => Reflect.get(window, "fixtureCopiedFullError") as string,
    );
    expect(copied).toBe(await alert.textContent());
    expect(copied).toContain(body.replaceAll(key, "[REDACTED]"));
    expect(copied.length).toBeGreaterThan(12_000);
    await page.screenshot({
      path: `${testInfo.outputDir}/${photo}`,
      fullPage: true,
    });
  };
  await message.fill("Trigger the structured HTTP failure.");
  await send.click();
  await verifyAndCopy(httpBody, httpSentinel, "phone-complete-http-error.png");
  await expect(page.getByRole("alert")).toContainText("HTTP 422");
  await expect(page.getByRole("alert")).toContainText(
    "application/problem+json",
  );
  await expect(page.getByRole("alert")).toContainText(
    "HTTP 422 Unprocessable Entity",
  );
  await expect(
    page.getByRole("alert"),
  ).toContainText("retryAfter");
  await expect(
    page.getByText(
      "Scroll for full details. Copy error includes the entire message.",
      { exact: true },
    ),
  ).toBeVisible();
  const previousDetails = page.getByLabel("Error details", { exact: true });
  await previousDetails.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => previousDetails.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  // Both the transcript error card and the global banner expose their own
  // Dismiss/Copy buttons; dismiss everything open so the stream error's
  // single-card assertions below stay unambiguous.
  for (let attempt = 0; attempt < 3; attempt++) {
    const dismiss = button("Dismiss error");
    if (await dismiss.count()) await dismiss.first().click();
  }
  await expect(button("Copy error")).toHaveCount(0);
  await message.fill("Trigger the structured stream failure.");
  await send.click();
  await verifyAndCopy(
    streamBody,
    streamSentinel,
    "phone-complete-stream-error.png",
  );
  expect(posts).toBe(2);
  await page.reload();
  await message.fill("Preserved after restarting the app.");
  await send.click();
  // After reload the transcript re-renders the two failed messages' compact
  // error notices; target the new credential error specifically.
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The saved credential is unavailable" }),
  ).toBeVisible();
  await expect(message).toHaveValue("Preserved after restarting the app.");
  expect(posts).toBe(2);
  await button("Fix connection").click();
  await button(`Use saved provider ${label}`).click();
  const providerKey = page.getByRole("textbox", {
    name: "Provider API key",
    exact: true,
  });
  if (!(await providerKey.first().isVisible().catch(() => false))) {
    const fold = button("Connection settings");
    if (await fold.count()) await fold.click();
  }
  await providerKey.first().fill(key);
  const repair = button("Save and use provider");
  if (!(await repair.first().isVisible().catch(() => false))) {
    const more = button("More actions");
    if (await more.count()) await more.click();
  }
  await repair.first().click();
  await expect(message).toHaveValue("Preserved after restarting the app.");
  await send.click();
  await expect(page.getByTestId("assistant-response-text")).toHaveAttribute(
    "aria-label",
    reply,
  );
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible();
  // Recovery must clear the actionable error state. Compact per-message
  // notices remain by design (they are the transcript's record of failed
  // replies), so assert the credential error and the full error card
  // (identified by its "Error details" scroller) are gone rather than
  // expecting zero alerts.
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The saved credential is unavailable" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Error details", { exact: true })).toHaveCount(
    0,
  );
  await expect(message).toHaveValue("");
  expect(posts).toBe(3);
  await page.screenshot({
    path: `${testInfo.outputDir}/phone-recovered-after-restart.png`,
    fullPage: true,
  });
  await page.goto("/chat?panel=diagnostics");
  const downloaded = page.waitForEvent("download");
  await button("Export log").click();
  const download = await downloaded;
  const tracePath = `${testInfo.outputDir}/safe-trace.json`;
  await download.saveAs(tracePath);
  const traceText = await readFile(tracePath, "utf8");
  const trace = JSON.parse(traceText) as {
    entries: { phase: string; detail: Record<string, unknown> }[];
  };
  expect(trace.entries.some((entry) => entry.phase === "failed")).toBe(true);
  for (const excluded of [
    key,
    label,
    httpSentinel,
    streamSentinel,
    reply,
    "H".repeat(200),
    "S".repeat(200),
  ])
    expect(traceText).not.toContain(excluded);
  for (const entry of trace.entries)
    for (const field of Object.keys(entry.detail))
      expect([
        "code",
        "status",
        "endpoint",
        "durationMs",
        "method",
        "errorName",
      ]).toContain(field);
  expect(runtimeErrors).toEqual([]);
  expect(blockedOrigins).toEqual([]);
});
