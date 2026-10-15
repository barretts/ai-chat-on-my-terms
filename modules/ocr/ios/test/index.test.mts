import assert from "node:assert/strict";
import test from "node:test";
import {
  CardFieldsSchema,
  OcrRequestSchema,
  OcrResultSchema,
  confirmContactWrite,
  isCardFieldsEmpty,
  parseCardFields,
  type ContactsPort,
} from "../src/index.ts";

const CARD_FIXTURE = [
  "Ada Lovelace",
  "Analytical Engines Ltd",
  "+1 (555) 010-2026",
  "ada@analytical.example",
  "https://analytical.example/ada",
].join("\n");

test("business-card fixture yields a strict field preview", () => {
  const fields = parseCardFields(CARD_FIXTURE);
  assert.equal(fields.name, "Ada Lovelace");
  assert.equal(fields.organization, "Analytical Engines Ltd");
  assert.equal(fields.phone, "+1 (555) 010-2026");
  assert.equal(fields.email, "ada@analytical.example");
  assert.equal(fields.website, "https://analytical.example/ada");
  assert.equal(CardFieldsSchema.safeParse(fields).success, true);
});

test("junk OCR cannot smuggle fields past the schema", () => {
  const junk = parseCardFields(
    ["<script>alert(1)</script>", "x".repeat(300), "!!!---!!!"].join("\n"),
  );
  assert.equal(isCardFieldsEmpty(junk), true);
  const weird = parseCardFields("call me\n555");
  assert.equal(CardFieldsSchema.safeParse(weird).success, true);
});

test("OCR contract stays on-device and bounded (step 1)", () => {
  assert.equal(
    OcrRequestSchema.safeParse({
      imageRef: "photo_Ab-9_z1",
      source: "screenshot",
      languages: ["en", "de-DE"],
    }).success,
    true,
  );
  assert.equal(
    OcrRequestSchema.safeParse({
      imageRef: "C:\\Users\\me\\pic.png",
      source: "screenshot",
    }).success,
    false,
  );
  assert.equal(
    OcrResultSchema.safeParse({
      text: "recognized",
      languageCode: "en",
      onDevice: false,
    }).success,
    false,
  );
  assert.equal(
    OcrResultSchema.safeParse({
      text: "x".repeat(40001),
      languageCode: null,
      onDevice: true,
    }).success,
    false,
  );
});

test("no Contacts write without the confirmed tap (smoke 2)", async () => {
  const writes: unknown[] = [];
  const contacts: ContactsPort = {
    async writeContact(fields) {
      writes.push(fields);
    },
  };
  const fields = parseCardFields(CARD_FIXTURE);
  assert.equal(await confirmContactWrite(fields, contacts, false), false);
  assert.deepEqual(writes, []);
  assert.equal(await confirmContactWrite(fields, contacts, true), true);
  assert.equal(writes.length, 1);
  assert.equal(
    await confirmContactWrite({ name: "x".repeat(200) }, contacts, true),
    false,
  );
  assert.equal(await confirmContactWrite({}, contacts, true), false);
  assert.equal(writes.length, 1);
});
