import { describe, expect, it } from "vitest";
import {
  exportAllChatsZip,
  exportConversationPdf,
  exportConversationTxt,
  importAllChatsZip,
  importLMStudioExport,
  validateArchiveEntries,
  UnsupportedLMStudioVersionError,
  ArchiveValidationError,
  type ZipEntry,
  type ZipPort,
} from "../src/index";

const enc = new TextEncoder();
const dec = new TextDecoder();
const zip: ZipPort = {
  encode: async (entries) =>
    enc.encode(
      JSON.stringify(
        entries.map((e) => ({ path: e.path, bytes: [...e.bytes] })),
      ),
    ),
  decode: async (bytes) =>
    JSON.parse(dec.decode(bytes)).map(
      (e: { path: string; bytes: number[] }) => ({
        path: e.path,
        bytes: new Uint8Array(e.bytes),
      }),
    ),
};
const conversation = {
  id: "c1",
  title: "Hello",
  messages: [
    {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "world" }],
      variants: [{ id: "v1", parts: [{ type: "text", text: "other" }] }],
    },
  ],
};

describe("chat archive contracts", () => {
  it("round trips conversations, variants, and required assets", async () => {
    const bytes = await exportAllChatsZip(
      [conversation],
      [
        {
          path: "image/a.png",
          mimeType: "image/png",
          bytes: new Uint8Array([1, 2]),
        },
      ],
      zip,
      "2026-01-01T00:00:00Z",
    );
    const result = await importAllChatsZip(bytes, zip);
    expect(result.conversations).toEqual([conversation]);
    expect([...result.assets[0]!.bytes]).toEqual([1, 2]);
  });
  it("excludes credential and PIN fields from exported content", async () => {
    const bytes = await exportAllChatsZip(
      [
        {
          ...conversation,
          apiKey: "secret-key",
          messages: [
            {
              ...conversation.messages[0]!,
              parts: [
                {
                  type: "text",
                  text: "ok",
                  pin: "1234",
                  accessToken: "hidden",
                },
              ],
            },
          ],
        } as unknown as typeof conversation,
      ],
      [],
      zip,
    );
    expect(dec.decode(bytes)).not.toContain("secret-key");
    expect(dec.decode(bytes)).not.toContain("1234");
    expect(dec.decode(bytes)).not.toContain("hidden");
  });
  it("imports v1 LM Studio captures and rejects unknown versions clearly", () => {
    expect(
      importLMStudioExport({
        version: 1,
        conversations: [
          { id: "x", messages: [{ role: "user", content: "hi" }] },
        ],
      })[0]?.messages[0]?.parts,
    ).toEqual([{ type: "text", text: "hi" }]);
    expect(() =>
      importLMStudioExport({ version: 99, conversations: [] }),
    ).toThrow(UnsupportedLMStudioVersionError);
  });
  it("rejects malformed/traversal entries and missing assets", async () => {
    expect(() =>
      validateArchiveEntries([{ path: "../escape", bytes: new Uint8Array() }]),
    ).toThrow(ArchiveValidationError);
    await expect(
      importAllChatsZip(enc.encode("bad"), {
        ...zip,
        decode: async () => {
          throw new Error("bad zip");
        },
      }),
    ).rejects.toThrow(/malformed or unreadable/);
    const bytes = await exportAllChatsZip(
      [conversation],
      [
        {
          path: "photo.jpg",
          mimeType: "image/jpeg",
          bytes: new Uint8Array([5]),
        },
      ],
      zip,
    );
    const withoutAsset: ZipPort = {
      ...zip,
      decode: async (b) =>
        (await zip.decode(b)).filter((e) => !e.path.endsWith("photo.jpg")),
    };
    await expect(importAllChatsZip(bytes, withoutAsset)).rejects.toThrow(
      /missing required asset/,
    );
  });
  it("provides TXT and PDF individual exports", () => {
    expect(dec.decode(exportConversationTxt(conversation))).toContain(
      "Variant 1",
    );
    expect(dec.decode(exportConversationPdf(conversation))).toContain(
      "%PDF-1.4",
    );
  });
});
