import { expect, test, type Page, type Route } from "@playwright/test";

// All OpenRouter requests use labeled fixtures. No real keys, cloud requests,
// account access, or paid generation are used by these rendered UI checks.
const apiBase = "https://openrouter.ai/api/v1";
const fixtureKey = "sk-or-ui-fixture-only";
const fixtureModel = "fixture-vendor/fixture-coder:free";
const fixtureModels = [
  fixtureModel,
  "fixture-vendor/fixture-general",
  "another-fixture/fixture-chat",
];
type SeenRequest = {
  url: string;
  method: string;
  authorization?: string;
  body?: Record<string, unknown>;
};

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

async function openConnectionsFromChat(page: Page) {
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
  const appbar = page.getByRole("button", {
    name: "Choose chat connection",
  });
  if (await appbar.count()) await appbar.click();
  else await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(heading.first()).toBeVisible();
}

async function openProviders(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const welcome = page.getByRole("heading", {
    name: "Welcome to AI Chat",
  });
  try {
    await welcome.first().waitFor({ state: "visible", timeout: 5000 });
  } catch {
    // Onboarding is already complete, so the app opens the chat directly.
    await expect(
      page
        .getByRole("heading", {
          name: /^(AI Chat|Offline chat)$/,
          exact: true,
        })
        .first(),
    ).toBeVisible();
    await openConnectionsFromChat(page);
    await page.getByRole("button", { name: "Add provider" }).click();
    const other = page.getByRole("button", { name: "Other", exact: true });
    if (await other.count()) await other.click();
    const name = page.getByRole("textbox", {
      name: "Provider name",
      exact: true,
    });
    if (!(await name.count()))
      await page.getByRole("button", { name: "Connection settings" }).click();
    await expect(name).toBeVisible();
    return;
  }
  await expandSetupPreferences(page);
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page
      .getByRole("heading", { name: /^(AI Chat|Offline chat)$/, exact: true })
      .first(),
  ).toBeVisible();
  await openConnectionsFromChat(page);
  await page.getByRole("button", { name: "Add provider" }).click();
  const other = page.getByRole("button", { name: "Other", exact: true });
  if (await other.count()) await other.click();
  const name = page.getByRole("textbox", {
    name: "Provider name",
    exact: true,
  });
  if (!(await name.count()))
    await page.getByRole("button", { name: "Connection settings" }).click();
  await expect(name).toBeVisible();
}

async function revealIfNeeded(page: Page, name: string) {
  // Phone folds model loading, testing, and saving into a "More actions"
  // accordion inside the connection editor.
  const target = page.getByRole("button", { name, exact: true });
  if (await target.count()) return;
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(target).toBeVisible();
}

async function chooseKind(page: Page, label: string, phoneLabel?: string) {
  // Desktop switches kinds through the "Provider type" dropdown; the phone
  // editor exposes the preset buttons ("This PC", "OpenRouter", "Other").
  const type = page.getByRole("button", { name: "Provider type", exact: true });
  if (await type.count()) {
    await type.click();
    await page
      .getByRole("button", { name: `Choose ${label}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Close Provider type", exact: true })
      .waitFor({ state: "hidden" });
    return;
  }
  await page
    .getByRole("button", { name: phoneLabel ?? label, exact: true })
    .click();
  // The phone editor keeps its fields folded behind "Connection settings".
  const fields = page.getByRole("textbox", {
    name: "Provider name",
    exact: true,
  });
  const settings = page.getByRole("button", { name: "Connection settings" });
  if (!(await fields.count()) && (await settings.count()))
    await settings.click();
}

async function customModel(page: Page, model: string) {
  const field = page.getByRole("textbox", {
    name: "Exact chat model ID",
    exact: true,
  });
  if (!(await field.count()))
    await page
      .getByRole("button", { name: "Enter custom model ID", exact: true })
      .click();
  await field.fill(model);
}

async function fixtureOpenRouter(
  page: Page,
  handle: (route: Route, url: string) => Promise<void>,
) {
  await page.route("https://openrouter.ai/**", (route) =>
    handle(route, route.request().url()),
  );
  await page.route("**/_locallab/provider?*", (route) => {
    const target = new URL(route.request().url()).searchParams.get("url");
    return target?.startsWith("https://openrouter.ai/")
      ? handle(route, target)
      : route.continue();
  });
}

function recordRequest(route: Route, url: string): SeenRequest {
  const request = route.request();
  const authorization = request.headers().authorization;
  return {
    url,
    method: request.method(),
    ...(authorization ? { authorization } : {}),
    ...(request.method() === "POST" ? { body: request.postDataJSON() } : {}),
  };
}

test("OpenRouter preset discovers, selects and saves an exact model using fixture authentication", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const requests: SeenRequest[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixtureOpenRouter(page, async (route, url) => {
    requests.push(recordRequest(route, url));
    if (url === `${apiBase}/models`) {
      await route.fulfill({
        json: { data: fixtureModels.map((id) => ({ id })) },
      });
    } else if (url === `${apiBase}/key`) {
      await route.fulfill({
        json: { data: { label: "fixture-key-check", limit_remaining: 1 } },
      });
    } else if (url === `${apiBase}/chat/completions`) {
      const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          frame({
            id: "openrouter-ui-fixture",
            choices: [
              { delta: { content: "OpenRouter UI fixture response." } },
            ],
          }) +
          frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          "data: [DONE]\n\n",
      });
    } else {
      await route.abort();
    }
  });
  await openProviders(page);
  await chooseKind(page, "OpenRouter");
  // The phone OpenRouter editor hides the (fixed) name/endpoint fields that
  // the desktop editor shows in a locked state.
  if (testInfo.project.name !== "phone") {
    await expect(
      page.getByRole("textbox", { name: "Provider name", exact: true }),
    ).toHaveValue("OpenRouter");
    const endpoint = page.getByRole("textbox", {
      name: "Provider endpoint URL",
      exact: true,
    });
    await expect(endpoint).toHaveValue(apiBase);
    await expect(endpoint).not.toBeEditable();
  }
  await expect(
    page.getByRole("link", {
      name: "Create an OpenRouter API key",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", {
      name: "Authorize local HTTP origin",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel("Provider API key", { exact: true }).fill(fixtureKey);
  await revealIfNeeded(page, "Load OpenRouter models");
  await page
    .getByRole("button", { name: "Load OpenRouter models", exact: true })
    .click();
  await expect(
    page.getByText(/^Found 3 models on your endpoint\./),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chat model", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search chat model", exact: true })
    .fill("fixture-coder");
  await expect(
    page.getByRole("button", { name: /^Choose fixture-vendor\/fixture-coder/ }),
  ).toHaveCount(1);
  await page
    .getByRole("button", {
      name: `Choose ${fixtureModel}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Chat model", exact: true }),
  ).toContainText(fixtureModel);
  await page
    .getByRole("button", { name: "Close Chat model", exact: true })
    .waitFor({ state: "hidden" });
  await revealIfNeeded(page, "Test connection");
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(
    page.getByText(`Connected: ${fixtureModel} is available.`, { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/openrouter-fixture-model-picker.png`,
    fullPage: true,
  });
  await revealIfNeeded(page, "Save and use provider");
  await page
    .getByRole("button", { name: "Save and use provider", exact: true })
    .click();
  if (testInfo.project.name === "phone") {
    // Phone's app bar shows the provider label; the model is folded away.
    await expect(
      page.getByRole("button", { name: "Choose chat connection" }),
    ).toContainText("OpenRouter");
  } else {
    await expect(
      page.getByText(`OpenRouter - ${fixtureModel}`, { exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: "Your connections", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("This is an intercepted UI fixture, not a real cloud request.");
  await page.getByTestId("advanced-composer-send").click();
  await expect(page.getByTestId("assistant-response-text")).toContainText(
    "OpenRouter UI fixture response.",
  );
  const generation = requests.filter((request) => request.method === "POST");
  expect(generation).toHaveLength(1);
  expect(generation[0]).toMatchObject({
    url: `${apiBase}/chat/completions`,
    authorization: `Bearer ${fixtureKey}`,
    body: {
      model: fixtureModel,
      provider: { allow_fallbacks: false },
      stream: true,
    },
  });
  // The current UI refreshes the OpenRouter catalogue whenever the key is
  // validated, the model list is (re)opened, and the provider is saved.
  expect(requests.filter((request) => request.method === "GET")).toHaveLength(
    5,
  );
  expect(requests[0]).toMatchObject({
    url: `${apiBase}/models`,
    method: "GET",
  });
  expect(requests[0].authorization).toBeUndefined();
  expect(
    requests
      .slice(1)
      .every((request) => request.authorization === `Bearer ${fixtureKey}`),
  ).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  if (testInfo.project.name === "phone") {
    await expect(
      page.getByRole("button", { name: "Choose chat connection" }),
    ).toContainText("OpenRouter");
  } else {
    await expect(
      page.getByText(`OpenRouter - ${fixtureModel}`, { exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByTestId("assistant-response-text")).toContainText(
    "OpenRouter UI fixture response.",
  );
  await openConnectionsFromChat(page);
  await expect(
    page.getByRole("button", {
      name: "Use saved provider OpenRouter",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit provider OpenRouter", exact: true })
    .click();
  const savedKey = page.getByRole("textbox", {
    name: "Provider API key",
    exact: true,
  });
  if (!(await savedKey.count()))
    await page.getByRole("button", { name: "Connection settings" }).click();
  await expect(savedKey).toHaveValue("");
  await testInfo.attach("openrouter-fixture-requests.json", {
    body: JSON.stringify(requests, null, 2),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
});

test("OpenRouter key, authentication, missing-model and empty discovery errors remain actionable", async ({
  page,
}, testInfo) => {
  let response: "unauthorized" | "models" | "empty" = "unauthorized";
  const requests: SeenRequest[] = [];
  await fixtureOpenRouter(page, async (route, url) => {
    requests.push(recordRequest(route, url));
    if (url === `${apiBase}/key` && response === "unauthorized") {
      await route.fulfill({
        status: 401,
        json: {
          error: { code: 401, message: `Invalid fixture key ${fixtureKey}` },
        },
      });
    } else if (url === `${apiBase}/key`) {
      await route.fulfill({ json: { data: { label: "fixture-key-check" } } });
    } else {
      expect(url).toBe(`${apiBase}/models`);
      await route.fulfill({
        json: {
          data: (response === "empty" ? [] : fixtureModels).map((id) => ({
            id,
          })),
        },
      });
    }
  });
  await openProviders(page);
  await chooseKind(page, "OpenRouter");
  for (const name of ["Save and use provider", "Test connection"]) {
    await customModel(page, fixtureModel);
    await revealIfNeeded(page, name);
    await page.getByRole("button", { name, exact: true }).click();
    // The current UI validates the key before save/test; the alert wraps the
    // missing-key reason ("...before saving.") instead of throwing it verbatim.
    await expect(page.getByRole("alert")).toContainText(
      "Enter your OpenRouter API key",
    );
  }
  expect(requests).toHaveLength(0);
  await page
    .getByRole("button", { name: "Load OpenRouter models", exact: true })
    .click();
  await expect(
    page.getByText(/^Found 3 models on your endpoint\./),
  ).toBeVisible();
  expect(requests[0].authorization).toBeUndefined();
  await page.getByLabel("Provider API key", { exact: true }).fill(fixtureKey);
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "OpenRouter rejected this API key",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Check the key and try again.",
  );
  await expect(page.getByRole("alert")).not.toContainText(fixtureKey);
  response = "models";
  await page
    .getByLabel("Provider API key", { exact: true })
    .fill(`${fixtureKey}-retry`);
  await page
    .getByRole("button", { name: "Load OpenRouter models", exact: true })
    .click();
  await expect(
    page.getByText(/^Found 3 models on your endpoint\./),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chat model", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search chat model", exact: true })
    .fill("no-such-fixture");
  await expect(
    page.getByText("No matches. Try another search.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close Chat model", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Exact chat model ID", exact: true })
    .fill("fixture-vendor/unlisted");
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "does not list fixture-vendor/unlisted",
  );
  response = "empty";
  await page
    .getByRole("button", { name: "Load OpenRouter models", exact: true })
    .click();
  await expect(
    page.getByText(/^Found 0 models on your endpoint\./),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Choose fixture-vendor\/fixture-coder/ }),
  ).toHaveCount(0);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  await page.screenshot({
    path: `${testInfo.outputDir}/openrouter-fixture-empty-models.png`,
    fullPage: true,
  });
});

test(
  "leaving the OpenRouter preset clears its key and preserves compatible local setup",
  async ({ page }, testInfo) => {
  const headers: Record<string, string>[] = [];
  await fixtureOpenRouter(page, (route) => route.abort());
  await page.route(
    "https://compatible-openrouter-ui-fixture.test/v1/models",
    async (route) => {
      headers.push(route.request().headers());
      await route.fulfill({
        json: { data: [{ id: "compatible-ui-fixture-model" }] },
      });
    },
  );
  await openProviders(page);
  await chooseKind(page, "OpenRouter");
  await page.getByLabel("Provider API key", { exact: true }).fill(fixtureKey);
  await chooseKind(page, "Local server · llama.cpp", "This PC");
  await expect(
    page.getByLabel("Provider API key", { exact: true }),
  ).toHaveValue("");
  const endpoint = page.getByRole("textbox", {
    name: "Provider endpoint URL",
    exact: true,
  });
  await expect(endpoint).toBeEditable();
  if (testInfo.project.name !== "phone") {
    await expect(endpoint).toHaveValue("");
  } else {
    // Phone's "This PC" preset pre-fills the discovered local llama.cpp
    // endpoint; what matters is that the fixed OpenRouter endpoint is gone.
    await expect(endpoint).not.toHaveValue(apiBase);
  }
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Compatible UI fixture");
  await endpoint.fill("https://compatible-openrouter-ui-fixture.test/v1");
  await customModel(page, "compatible-ui-fixture-model");
  await revealIfNeeded(page, "Test connection");
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(
    page.getByText("Connected: compatible-ui-fixture-model is available.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(headers).toHaveLength(1);
  expect(headers[0].authorization).toBeUndefined();
  await revealIfNeeded(page, "Save and use provider");
  await page
    .getByRole("button", { name: "Save and use provider", exact: true })
    .click();
  if (testInfo.project.name === "phone") {
    // The phone app bar shows the provider label alone; the model is folded
    // behind the connection picker.
    await expect(
      page.getByText("Compatible UI fixture", { exact: true }),
    ).toBeVisible();
  } else {
    await expect(
      page.getByText("Compatible UI fixture - compatible-ui-fixture-model", {
        exact: true,
      }),
    ).toBeVisible();
  }
});
