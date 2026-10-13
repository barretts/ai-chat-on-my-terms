import { expect, test } from "@playwright/test";

test("browsers show honest dictation capability instead of a fake record control", async ({
  page,
}, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (cause) => runtimeErrors.push(cause.message));
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await page.goto("/");
  await button("Continue without a model").click();
  await expect(page.getByTestId("advanced-composer-input")).toBeVisible();

  // The composer tool row: no recording control, an honest statement instead.
  if ((await page.viewportSize().width) <= 600)
    await button("Show message tools").click();
  await expect(page.getByTestId("advanced-composer-dictate")).toHaveCount(0);
  await expect(
    page.getByText(/system speech recognizer, which this platform does not expose/),
  ).toBeVisible();

  // Voice Studio carries the same honesty plus the persisted controls.
  if ((await page.viewportSize().width) <= 600) {
    await button("Close message tools").click();
    await button("Open chat menu").click();
  }
  await button("Voices").click();
  await expect(page.getByTestId("speech-dictation-status")).toHaveText(
    /system speech recognizer, which this platform does not expose/,
  );
  await expect(
    page.getByRole("switch", {
      name: "Send the dictated message automatically",
    }),
  ).toBeVisible();
  await page.screenshot({
    path: `${testInfo.outputDir}/${testInfo.project.name}-dictation-capability.png`,
    fullPage: true,
  });
  expect(runtimeErrors).toEqual([]);
});
