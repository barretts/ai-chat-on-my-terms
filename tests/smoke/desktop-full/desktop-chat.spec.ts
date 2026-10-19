import { chromium, expect, test } from "@playwright/test";
import {
  CDP_PORT,
  killApp,
  launchApp,
  resetAppData,
  startFixtureServer,
  stopFixtureServer,
  waitForCdp,
} from "./app.mjs";

// One sequential test drives the built WebView2 app end-to-end: fresh
// onboarding, a saved OpenAI-compatible provider pointed at a local fixture,
// a streamed chat reply, then a restart that must show the history and let a
// second message through using the credential that survived in the keyring.
// A single test is deliberate: two live apps sharing the WebView2 data dir
// race each other.

// Copied (non-phone paths) from tests/ui/library-connections.spec.ts.
async function expandSetupPreferences(page) {
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

async function openConnectionsPanel(page) {
  const heading = page.getByRole("heading", {
    name: "Your connections",
    exact: true,
  });
  try {
    await heading.first().waitFor({ state: "visible", timeout: 4000 });
    return;
  } catch {
    // The panel starts closed; open it via the rail/appbar trigger.
  }
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(heading.first()).toBeVisible();
}

async function backToChat(page) {
  if (await page.getByRole("button", { name: "Add provider" }).count()) {
    await page.getByRole("button", { name: "Back to chat" }).click();
  }
  await expect(
    page.getByRole("button", { name: "Add provider" }).first(),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("heading", { name: /^(AI Chat|Offline chat)$/, exact: true })
      .first(),
  ).toBeVisible();
}

// Attach to the app's own WebView2 over CDP and return its page.
async function connectAppPage() {
  await waitForCdp(CDP_PORT, 60_000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  for (const context of browser.contexts()) {
    for (const candidate of context.pages()) {
      if (/^https?:\/\/tauri\.localhost/.test(candidate.url())) {
        return { browser, page: candidate };
      }
    }
  }
  await browser.close();
  throw new Error("no tauri.localhost page found over CDP");
}

async function sendMessage(page, text) {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toBeEditable();
  await message.fill(text);
  await page.getByTestId("advanced-composer-send").click();
}

test("onboard, chat through a fixture provider, and survive an app restart", async (_fixtures, testInfo) => {
  test.setTimeout(300_000);
  const pageErrors = [];
  const fixture = startFixtureServer();
  let browser = null;
  let child = null;
  try {
    // 1. Fresh install: launch and attach to the app webview.
    resetAppData();
    child = launchApp();
    let page;
    ({ browser, page } = await connectAppPage());
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    // 2. Onboarding with no model choice.
    await expect(
      page.getByRole("heading", { name: "Welcome to AI Chat" }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expandSetupPreferences(page);
    await page
      .getByRole("button", { name: /^Choose power user setup/ })
      .click();
    await page
      .getByRole("button", { name: "Continue without a model", exact: true })
      .click();
    await expect(
      page
        .getByRole("heading", { name: /^(AI Chat|Offline chat)$/, exact: true })
        .first(),
    ).toBeVisible();

    // 3. Save an OpenAI-compatible provider aimed at the loopback fixture.
    await openConnectionsPanel(page);
    await page.getByRole("button", { name: "Add provider" }).click();
    // A provider-type picker may appear; "Other" is the OpenAI-compatible
    // path. Desktop usually lands in the editor with it already chosen.
    const other = page.getByRole("button", { name: "Other", exact: true });
    if (await other.count()) await other.click();
    await page
      .getByRole("textbox", { name: "Provider name", exact: true })
      .fill("Desktop fixture");
    await page
      .getByRole("textbox", { name: "Provider endpoint URL", exact: true })
      .fill("http://127.0.0.1:4599/v1");
    await page
      .getByRole("textbox", { name: "Provider API key", exact: true })
      .fill("smoke-desk-key");
    const exactModel = page.getByRole("textbox", {
      name: "Exact chat model ID",
      exact: true,
    });
    if (!(await exactModel.count())) {
      await page.getByRole("button", { name: "Enter custom model ID" }).click();
    }
    await exactModel.fill("desktop-smoke");
    await page.getByRole("button", { name: "Save provider to list" }).click();
    await expect(
      page.getByText("Desktop fixture saved. It's in your provider list.", {
        exact: true,
      }),
    ).toBeVisible();
    await backToChat(page);

    // 4. Point the chat at the saved provider.
    await openConnectionsPanel(page);
    await page
      .getByRole("button", { name: "Use saved provider Desktop fixture" })
      .click();
    await backToChat(page);

    // 5. First streamed reply comes from the fixture.
    await sendMessage(page, "first desktop smoke message");
    await expect(
      page.getByTestId("assistant-response-text").last(),
    ).toContainText("Desktop fixture reply.");

    // 6. Restart without clearing app data: the provider, its keyring-held
    // key, and the transcript must all survive.
    page.off("pageerror");
    await browser.close({ reason: "restarting app" });
    await killApp(child);
    child = launchApp();
    ({ browser, page } = await connectAppPage());
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await expect(
      page.getByTestId("assistant-response-text").first(),
    ).toContainText("Desktop fixture reply.");

    // No re-entered key: this only works if the saved credential persisted.
    await sendMessage(page, "second after restart");
    await expect(
      page.getByTestId("assistant-response-text").last(),
    ).toContainText("Second desktop fixture reply.");

    await page.screenshot({
      path: testInfo.outputPath("desktop-chat-final.png"),
      fullPage: true,
    });
    expect(pageErrors).toEqual([]);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child && child.exitCode === null) await killApp(child).catch(() => {});
    await stopFixtureServer(fixture).catch(() => {});
  }
});
