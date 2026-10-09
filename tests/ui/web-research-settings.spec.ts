import { expect, test } from "@playwright/test";

test("Brave settings save securely, test only on request, recover missing browser keys and remain usable on a phone", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 956 });
  const errors: string[] = [];
  const searches: string[] = [];
  const fixtureKey = "locallab-fixture-brave-key-not-a-real-key";
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/_locallab/search-api?**", async (route) => {
    searches.push(route.request().url());
    expect(route.request().headers()["x-subscription-token"]).toBe(fixtureKey);
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().url()).not.toContain(fixtureKey);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        web: {
          results: [
            {
              title: "Expo documentation",
              url: "https://docs.expo.dev/",
              description: "Official Expo documentation.",
            },
          ],
        },
      },
    });
  });
  // All paid service requests are intercepted. Any accidental direct request
  // is rejected, so this test cannot spend an API request allowance.
  await page.route("https://api.search.brave.com/**", (route) => route.abort());
  await page.goto("/chat?panel=research");
  await expect(async () => {
    const skip = page.getByRole("button", {
      name: "Continue without a model",
      exact: true,
    });
    if (await skip.isVisible()) await skip.click();
    await expect(
      page.getByRole("button", { name: "Search service", exact: true }),
    ).toBeVisible();
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText(/Public search may be blocked/)).toBeVisible();
  await page
    .getByRole("button", { name: "Search service", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose Brave Search API", exact: true })
    .click();
  const key = page.getByRole("textbox", {
    name: "Brave Search API key",
    exact: true,
  });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill(fixtureKey);
  await expect(
    page.getByRole("button", {
      name: "Test saved web search service",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Save web search settings", exact: true })
    .click();
  await expect(
    page.getByText("Web search settings saved.", { exact: true }),
  ).toBeVisible();
  await expect(key).toHaveValue("");
  expect(searches).toHaveLength(0);
  expect(
    await page.evaluate(() => JSON.stringify(Object.entries(localStorage))),
  ).not.toContain(fixtureKey);
  await page
    .getByRole("button", { name: "Test saved web search service", exact: true })
    .click();
  await expect(
    page.getByText(/Search connected\. 1 result returned/),
  ).toBeVisible();
  expect(searches).toHaveLength(1);
  await page.screenshot({
    path: `${testInfo.outputDir}/brave-search-configured.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Read saved Brave Search key failed." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Test saved web search service",
      exact: true,
    }),
  ).toBeDisabled();
  expect(searches).toHaveLength(1);
  await page
    .getByRole("button", { name: "Remove saved Brave Search key", exact: true })
    .click();
  await expect(
    page.getByText("Saved key removed. Public search is selected.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Brave Search API key", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
