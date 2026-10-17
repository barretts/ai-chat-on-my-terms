import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";

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

async function openChat(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to LocalLab" }),
  ).toBeVisible();
  await expandSetupPreferences(page);
  await page.getByRole("button", { name: /^Choose power user setup/ }).click();
  await page.getByRole("button", { name: /^Choose dark theme/ }).click();
  await page
    .getByRole("button", { name: "Continue without a model", exact: true })
    .click();
  await expect(
    page
      .getByRole("heading", { name: /^(LocalLab|Offline chat)$/, exact: true })
      .first(),
  ).toBeVisible();
}

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Labelled two-pixel PNG fixtures, decoded by the actual image component and browser intake. */
function avatarFixture(rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, content: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type), content]);
    let crc = 0xffffffff;
    for (const byte of typed) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(content.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, typed, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.from([0, ...rgb, 255, ...rgb, 255]);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Read-only observation of the production browser managed-byte adapter, without seeding it. */
async function managedBytes(page: Page) {
  const entries = await page.evaluate(async () => {
    if (
      !(await indexedDB.databases()).some(
        (db) => db.name === "locallab-managed-blobs",
      )
    )
      return [];
    return new Promise<Array<{ path: string; bytes: number[] }>>(
      (resolve, reject) => {
        const request = indexedDB.open("locallab-managed-blobs");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("files", "readonly");
          const rows: Array<{ path: string; bytes: number[] }> = [];
          const cursor = tx.objectStore("files").openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            rows.push({
              path: String(row.key),
              bytes: [...new Uint8Array(row.value as ArrayBuffer)],
            });
            row.continue();
          };
          tx.oncomplete = () => {
            db.close();
            resolve(rows);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      },
    );
  });
  return entries
    .map(({ path, bytes }) => ({
      path,
      sha256: hash(Buffer.from(bytes)),
      byteLength: bytes.length,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function chooseAvatar(page: Page, name: string, bytes: Buffer) {
  const pending = page.waitForEvent("filechooser");
  const pick = page.getByRole("button", {
    name: "Choose Persona avatar",
    exact: true,
  });
  // The phone editor folds the avatar controls into a collapsible section.
  if (!(await pick.isVisible().catch(() => false))) {
    const fold = page.getByRole("button", {
      name: "Persona avatar and colors options",
    });
    if (await fold.count()) await fold.click();
  }
  await pick.click();
  await (
    await pending
  ).setFiles({ name, mimeType: "image/png", buffer: bytes });
  await expect(
    page.getByRole("button", { name: "Save Persona profile", exact: true }),
  ).toBeEnabled();
}

async function avatarHash(page: Page, name: string) {
  const bytes = await page
    .getByRole("img", { name: `${name} avatar`, exact: true })
    .first()
    .evaluate(async (element) => {
      const image = element.matches("img")
        ? (element as HTMLImageElement)
        : element.querySelector("img")!;
      await image.decode();
      if (image.naturalWidth !== 2)
        throw new Error("Avatar fixture did not decode");
      return [...new Uint8Array(await (await fetch(image.src)).arrayBuffer())];
    });
  return hash(Buffer.from(bytes));
}

test("System theme follows browser color scheme and cleared initials stay absent after reload", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "light" });
  await openChat(page);
  const system = page.getByRole("button", {
    name: /^Use system app theme(?:, selected)?$/,
  });
  const openSettings = async () => {
    if (
      await system
        .waitFor({ state: "visible", timeout: 4000 })
        .then(() => true)
        .catch(() => false)
    )
      return;
    const back = page.getByRole("button", {
      name: /^(Return to (conversation|chat)|Back to (conversation|chat))$/,
    });
    if (await back.first().isVisible().catch(() => false))
      await back.first().click();
    const menu = page.getByRole("button", {
      name: "Open chat menu",
      exact: true,
    });
    if (await menu.count()) await menu.click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(system).toBeVisible();
  };
  await openSettings();
  await system.click();
  await expect(system).toHaveAccessibleName(/^Use system app theme(, selected)?$/);
  const background = () =>
    page
      .getByRole("heading", { level: 1 })
      .first()
      .evaluate((element) => {
        let node: Element | null = element;
        while (node) {
          const color = getComputedStyle(node).backgroundColor;
          if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)")
            return color;
          node = node.parentElement;
        }
        return "transparent";
      });
  const light = await background();
  expect(light).not.toBe("transparent");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() =>
      page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches),
    )
    .toBe(true);
  await testInfo.attach("browser-dark-media-query", {
    body: JSON.stringify(
      await page.evaluate(() => ({
        dark: matchMedia("(prefers-color-scheme: dark)").matches,
      })),
    ),
    contentType: "application/json",
  });
  await expect.poll(background).not.toBe(light);
  const dark = await background();
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(background).toBe(light);
  const initials = page.getByRole("textbox", {
    name: "Chat avatar initials",
    exact: true,
  });
  const appearance = page.getByRole("button", {
    name: "Chat appearance",
    exact: true,
  });
  if (await appearance.count()) await appearance.click();
  await initials.fill("BC");
  await expect(
    page.getByText(/^(Changes saved|Settings loaded)$/).first(),
  ).toBeVisible();
  // The phone hub replaces the conversation; close it to inspect the avatar.
  const closeSettings = page.getByRole("button", {
    name: /^(Return to conversation|Return to chat|Back to (conversation|chat))$/,
  });
  if (await closeSettings.first().isVisible().catch(() => false))
    await closeSettings.first().click();
  else await page.getByRole("button", { name: "Settings", exact: true }).click();
  // The conversation avatar renders only in the desktop chat header; the
  // phone app bar omits it (product behavior gap, reported).
  if (((await page.viewportSize()?.width) ?? 0) > 600)
    await expect(
      page.getByLabel("Conversation avatar BC", { exact: true }),
    ).toBeVisible();
  await openSettings();
  if (await appearance.count()) await appearance.click();
  await initials.fill("");
  await expect(
    page.getByText(/^(Changes saved|Settings loaded)$/).first(),
  ).toBeVisible();
  if (await closeSettings.first().isVisible().catch(() => false))
    await closeSettings.first().click();
  else await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByLabel("Conversation avatar BC", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1 }).first(),
  ).toBeVisible();
  await expect.poll(background).toBe(light);
  await expect(page.getByLabel(/^Conversation avatar /)).toHaveCount(0);
  await openSettings();
  await expect(system).toHaveAccessibleName(/^Use system app theme(, selected)?$/);
  if (await appearance.count()) await appearance.click();
  await expect(initials).toHaveValue("");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(background).toBe(dark);
  await page.screenshot({
    path: testInfo.outputPath("system-theme-dark-cleared-initials.png"),
    fullPage: true,
  });
  await testInfo.attach("actual-system-theme-colors", {
    body: JSON.stringify({ light, dark }),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
});

test("Avatar cancellation preserves saved bytes while replacement and removal collect unused managed bytes", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openChat(page);
  const baseline = await managedBytes(page);
  const openPersonas = async () => {
    const create = page.getByRole("button", {
      name: "Create Persona",
      exact: true,
    });
    if (
      await create
        .waitFor({ state: "visible", timeout: 4000 })
        .then(() => true)
        .catch(() => false)
    )
      return;
    const back = page.getByRole("button", {
      name: /^(Return to (conversation|chat)|Back to (conversation|chat))$/,
    });
    if (await back.first().isVisible().catch(() => false))
      await back.first().click();
    const menu = page.getByRole("button", {
      name: "Open chat menu",
      exact: true,
    });
    if (await menu.count()) {
      await menu.click();
      const more = page.getByRole("button", {
        name: "More tools",
        exact: true,
      });
      if (await more.count()) await more.click();
    }
    await page.getByRole("button", { name: "Personas", exact: true }).click();
    await expect(create).toBeVisible();
  };
  await openPersonas();
  await page
    .getByRole("button", { name: "Create Persona", exact: true })
    .click();
  const name = "Boundary Avatar";
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  const media = page.getByRole("button", {
    name: "Persona avatar and colors options",
    exact: true,
  });
  if (await media.count()) await media.click();
  const original = avatarFixture([14, 145, 79]);
  const discarded = avatarFixture([193, 51, 83]);
  const replacement = avatarFixture([30, 80, 211]);
  await chooseAvatar(page, "fixture-original-green.png", original);
  await expect.poll(() => avatarHash(page, name)).toBe(hash(original));
  await page
    .getByRole("button", { name: "Save Persona profile", exact: true })
    .click();
  await expect(
    page.getByLabel(`Persona profile ${name}`, { exact: true }),
  ).toBeVisible();
  const saved = await managedBytes(page);
  expect(saved.filter((row) => row.sha256 === hash(original))).toHaveLength(1);
  expect(saved).toHaveLength(baseline.length + 1);
  await page
    .getByRole("button", { name: `Edit profile for ${name}`, exact: true })
    .click();
  if (await media.count()) await media.click();
  const canceledPicker = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Choose Persona avatar", exact: true })
    .click();
  // A real browser chooser reports a selection with zero files, the cancellation branch of intake.
  await (await canceledPicker).setFiles([]);
  await expect(
    page.getByRole("button", { name: "Save Persona profile", exact: true }),
  ).toBeEnabled();
  await expect.poll(() => avatarHash(page, name)).toBe(hash(original));
  expect(await managedBytes(page)).toEqual(saved);
  await chooseAvatar(page, "fixture-discarded-red.png", discarded);
  await expect.poll(() => avatarHash(page, name)).toBe(hash(discarded));
  expect(
    (await managedBytes(page)).some((row) => row.sha256 === hash(original)),
  ).toBe(true);
  await page
    .getByRole("button", {
      name: "Cancel Persona profile editing",
      exact: true,
    })
    .click();
  await expect.poll(() => managedBytes(page)).toEqual(saved);
  await expect.poll(() => avatarHash(page, name)).toBe(hash(original));
  await page.reload();
  await openPersonas();
  await expect.poll(() => avatarHash(page, name)).toBe(hash(original));
  await page
    .getByRole("button", { name: `Edit profile for ${name}`, exact: true })
    .click();
  if (await media.count()) await media.click();
  await chooseAvatar(page, "fixture-replacement-blue.png", replacement);
  await page
    .getByRole("button", { name: "Save Persona profile", exact: true })
    .click();
  await expect.poll(() => avatarHash(page, name)).toBe(hash(replacement));
  await expect
    .poll(async () =>
      (await managedBytes(page)).map((row) => row.sha256).sort(),
    )
    .toEqual([...baseline.map((row) => row.sha256), hash(replacement)].sort());
  const replaced = await managedBytes(page);
  await page.reload();
  await openPersonas();
  await expect.poll(() => avatarHash(page, name)).toBe(hash(replacement));
  await page
    .getByRole("button", { name: `Edit profile for ${name}`, exact: true })
    .click();
  if (await media.count()) await media.click();
  await page
    .getByRole("button", { name: "Remove Persona avatar", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save Persona profile", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: `${name} avatar`, exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => managedBytes(page)).toEqual(baseline);
  await page.reload();
  await openPersonas();
  await expect(
    page.getByRole("img", { name: `${name} avatar`, exact: true }),
  ).toHaveCount(0);
  expect(await managedBytes(page)).toEqual(baseline);
  await testInfo.attach("actual-managed-avatar-byte-lifecycle", {
    body: JSON.stringify(
      { baseline, saved, replaced, removed: await managedBytes(page) },
      null,
      2,
    ),
    contentType: "application/json",
  });
  await page.screenshot({
    path: testInfo.outputPath("avatar-boundary-cleanup.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Memory search treats percent and underscore as literal saved text", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openChat(page);
  const openMemory = async () => {
    const factInput = page.getByRole("textbox", {
      name: "New memory fact",
      exact: true,
    });
    if (
      await factInput
        .waitFor({ state: "visible", timeout: 4000 })
        .then(() => true)
        .catch(() => false)
    )
      return;
    const back = page.getByRole("button", {
      name: /^(Return to conversation|Back to chat)$/,
    });
    if (await back.first().isVisible().catch(() => false))
      await back.first().click();
    const menu = page.getByRole("button", {
      name: "Open chat menu",
      exact: true,
    });
    if (await menu.count()) {
      await menu.click();
      const more = page.getByRole("button", {
        name: "More tools",
        exact: true,
      });
      if (await more.count()) await more.click();
    }
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(factInput).toBeVisible();
  };
  await openMemory();
  const facts = [
    "My completion target is 95% coverage.",
    "My project identifier is cedar_branch.",
    "My plain project is Cedar.",
  ];
  for (const fact of facts) {
    await page
      .getByRole("textbox", { name: "New memory fact", exact: true })
      .fill(fact);
    await page
      .getByRole("button", { name: "Save memory fact", exact: true })
      .click();
    await expect(page.getByText(fact, { exact: true })).toBeVisible();
  }
  const search = page.getByLabel("Search saved memory", { exact: true });
  for (const [query, fact] of [
    ["%", facts[0]!],
    ["_", facts[1]!],
  ] as const) {
    await search.fill(query);
    await expect(
      page.getByLabel("Saved memory entry", { exact: true }),
    ).toHaveCount(1);
    await expect(page.getByText(fact, { exact: true })).toBeVisible();
    await expect(page.getByText(facts[2]!, { exact: true })).toHaveCount(0);
  }
  await search.fill("%_");
  await expect(
    page.getByText("No saved facts match your search.", { exact: true }),
  ).toBeVisible();
  await search.fill("  ");
  await expect(
    page.getByLabel("Saved memory entry", { exact: true }),
  ).toHaveCount(3);
  await page.reload();
  await openMemory();
  await search.fill("cedar_branch");
  await expect(
    page.getByLabel("Saved memory entry", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText(facts[1]!, { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("memory-literal-search.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Real extracted Memory remains editable and opens its exact source from a different chat", async ({
  page,
}, testInfo) => {
  const apiBase = process.env.LOCALLAB_LIVE_API_BASE;
  const model = process.env.LOCALLAB_LIVE_MODEL ?? "local-coder";
  test.skip(
    !apiBase,
    "Set LOCALLAB_LIVE_API_BASE to exercise real sourced memory.",
  );
  test.setTimeout(180_000);
  const errors: string[] = [];
  const requests: Array<{ target: string; body: any; extraction: boolean }> =
    [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    const target =
      url.pathname === "/_locallab/provider"
        ? url.searchParams.get("url")
        : request.url();
    if (request.method() !== "POST" || !target?.endsWith("/chat/completions"))
      return;
    const body = request.postDataJSON();
    requests.push({
      target,
      body,
      extraction: body.messages?.some(
        (item: { role: string; content: unknown }) =>
          item.role === "system" &&
          String(item.content).includes("Extract durable candidate facts"),
      ),
    });
  });
  await openChat(page);
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("tab", { name: "compatible", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Provider name", exact: true })
    .fill("Memory boundary local server");
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
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(
    page.getByText(`Connected: ${model} is available.`, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save and use provider", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await page
    .getByRole("textbox", { name: "System prompt", exact: true })
    .fill("<|think_off|>\nReply with one brief sentence.");
  await page
    .getByRole("textbox", { name: "Maximum output tokens", exact: true })
    .fill("768");
  await page
    .getByRole("textbox", { name: "Context window", exact: true })
    .fill("16384");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page
    .getByRole("switch", {
      name: "Extract memory after completed replies",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("switch", {
      name: "Extract memory after completed replies",
      exact: true,
    }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Close memory", exact: true }).click();
  const sourceText =
    "My preferred code editor is Helix. Acknowledge this durable preference in one brief sentence.";
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(sourceText);
  await page.getByTestId("advanced-composer-send").click();
  await expect(
    page.getByText("Response complete", { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("assistant-response-text")).toContainText(
    "Helix",
  );
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect
    .poll(
      async () => {
        await page
          .getByRole("button", { name: "Refresh saved memory", exact: true })
          .click();
        return page
          .getByLabel("Saved memory entry", { exact: true })
          .filter({ hasText: "Helix" })
          .count();
      },
      { timeout: 60_000, intervals: [250, 500, 1000] },
    )
    .toBe(1);
  const entry = page
    .getByLabel("Saved memory entry", { exact: true })
    .filter({ hasText: "Helix" });
  await expect(
    entry.getByText("Across conversations / Extracted from a completed turn", {
      exact: true,
    }),
  ).toBeVisible();
  const quote = await entry.getByText(/^Source quote:/).innerText();
  expect(quote).toContain("Helix");
  await entry
    .getByRole("button", { name: "Edit saved memory", exact: true })
    .click();
  const edited = "My preferred code editor is Helix for everyday coding.";
  await page
    .getByRole("textbox", { name: "Edit saved memory fact", exact: true })
    .fill(edited);
  await page
    .getByRole("button", { name: "Save memory edit", exact: true })
    .click();
  await expect(
    entry.getByText("Across conversations / Edited by you", { exact: true }),
  ).toBeVisible();
  await expect(entry.getByText(edited, { exact: true })).toBeVisible();
  await expect(entry.getByText(/^Source quote:/)).toHaveText(quote);
  await page
    .getByRole("switch", {
      name: "Extract memory after completed replies",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("switch", {
      name: "Extract memory after completed replies",
      exact: true,
    }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Close memory", exact: true }).click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByText(sourceText, { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "LocalLab Chat", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(sourceText, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(entry.getByText(edited, { exact: true })).toBeVisible();
  await expect(entry.getByText(/^Source quote:/)).toHaveText(quote);
  await entry
    .getByRole("button", { name: "Open source message", exact: true })
    .click();
  const source = page.getByTestId("source-message");
  await expect(source).toContainText(sourceText);
  // Both the source and accessibility wrappers contain Copy controls; target the primary paragraph.
  await expect(source.getByText(sourceText, { exact: true })).toBeInViewport({
    ratio: 0.9,
  });
  await expect(
    page.getByRole("heading", { name: "Source message", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("assistant-response-text")).toContainText(
    "Helix",
  );
  expect(requests.filter((request) => !request.extraction)).toHaveLength(1);
  expect(requests.filter((request) => request.extraction)).toHaveLength(1);
  const extraction = requests.find((request) => request.extraction)!;
  expect(extraction.target).toBe(
    `${apiBase!.replace(/\/$/, "")}/chat/completions`,
  );
  expect(
    extraction.body.messages.find(
      (item: { role: string }) => item.role === "system",
    ).content,
  ).toMatch(/^<\|think_off\|>\s+Extract durable candidate facts/);
  const requestEvidence = testInfo.outputPath(
    "actual-sourced-memory-requests.json",
  );
  await writeFile(requestEvidence, JSON.stringify(requests, null, 2));
  await testInfo.attach("actual-sourced-memory-requests", {
    path: requestEvidence,
    contentType: "application/json",
  });
  await page.screenshot({
    path: testInfo.outputPath("edited-memory-cross-chat-source.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
