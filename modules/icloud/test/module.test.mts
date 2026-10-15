/**
 * T100 (SY-09): the CloudKit bridge contract fails closed and the
 * account-state copy covers every CKContainer state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ICloudAccountNotes,
  ICloudError,
  parseICloudPage,
  parseICloudRecords,
  recordKey,
} from "../src/index.js";

const ID = "0198f2a3-0000-7000-8000-000000009100";

test("account notes cover every CloudKit account state", () => {
  const notes = ICloudAccountNotes;
  for (const state of ["available", "noAccount", "restricted", "temporarilyUnavailable", "couldNotComplete"] as const) {
    assert.equal(typeof notes[state], "string");
    assert.notEqual(notes[state], "");
  }
});

test("change pages and records parse fail-closed", () => {
  assert.throws(() => parseICloudPage({ records: [], cursor: "", more: false }), ICloudError);
  assert.throws(
    () =>
      parseICloudRecords([
        {
          recordName: "message:" + ID,
          entityType: "message",
          entityId: "not-an-uuid",
          revision: { wallMs: 1, counter: 0, deviceId: ID },
          payload: null,
          assetSha256: null,
          updatedAt: "2026-10-14T12:00:00.000Z",
        },
      ]),
    (error: unknown) => error instanceof ICloudError && error.kind === "malformed",
  );
  const page = parseICloudPage({
    records: [
      {
        recordName: "message:" + ID,
        entityType: "message",
        entityId: ID,
        revision: { wallMs: 1, counter: 0, deviceId: ID },
        payload: { body: "ok" },
        assetSha256: null,
        updatedAt: "2026-10-14T12:00:00.000Z",
      },
    ],
    cursor: "1",
    more: false,
  });
  assert.equal(page.records.length, 1);
});

test("record names split back into entity coordinates", () => {
  assert.deepEqual(recordKey("message:" + ID), { entityType: "message", entityId: ID });
  assert.equal(recordKey(""), null);
  assert.equal(recordKey("message:"), null);
  assert.equal(recordKey(":x"), null);
});
