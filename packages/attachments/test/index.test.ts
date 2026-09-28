import { describe, expect, it } from "vitest";
import {
  AttachmentError,
  classifyAttachment,
  compressAndResend,
  ingestAttachment,
  mapVisionAttachments,
  prepareOversizedImageRetry,
  retainAttachments,
  type AttachmentBlobPort,
  type AttachmentDescriptor,
  type ExtractionPort,
} from "../src/index.js";

const uuid = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
function setup() {
  const records = new Map<string, AttachmentDescriptor>();
  const retained: string[] = [];
  const managed = new Map<
    string,
    { uri: string; mimeType: string; byteLength: number }
  >();
  const blobs: AttachmentBlobPort = {
    async importManaged(_source, id) {
      const blobRef = uuid(Number(id.slice(-1)) + 10);
      managed.set(blobRef, {
        uri: "managed://" + blobRef,
        mimeType: "application/pdf",
        byteLength: 10,
      });
      return { blobRef, sha256: "a".repeat(64), byteLength: 10 };
    },
    async getManaged(ref) {
      return managed.get(ref);
    },
    async save(value) {
      records.set(value.id, value);
    },
    async get(id) {
      return records.get(id);
    },
    async retain(owner, id) {
      retained.push(owner + ":" + id);
    },
    async release(owner, id) {
      retained.splice(retained.indexOf(owner + ":" + id), 1);
    },
  };
  const extraction: ExtractionPort = {
    async pdf(_uri, bounds) {
      return { text: "bounded text".slice(0, bounds.maxCharacters), pages: 1 };
    },
    async xlsx(_uri, bounds) {
      return {
        text: "cells".slice(0, bounds.maxCharacters),
        entries: 2,
        uncompressedBytes: 16,
      };
    },
    async text() {
      return "text";
    },
  };
  return { blobs, extraction, records, retained, managed };
}

describe("attachments", () => {
  it("classifies supported files and rejects unknown types explicitly", () => {
    expect(classifyAttachment("application/octet-stream", "notes.md")).toBe(
      "markdown",
    );
    expect(classifyAttachment("image/jpeg; quality=1")).toBe("image");
    expect(() => classifyAttachment("application/zip", "x.zip")).toThrowError(
      AttachmentError,
    );
  });
  it("manages a PDF before bounded extraction and keeps it when extraction is canceled", async () => {
    const f = setup();
    const abort = new AbortController();
    const extraction = {
      ...f.extraction,
      async pdf() {
        abort.abort();
        throw new DOMException("cancelled", "AbortError");
      },
    };
    await expect(
      ingestAttachment(
        {
          name: "doc.pdf",
          mimeType: "application/pdf",
          byteLength: 10,
          sourceUri: "picker://1",
        },
        {
          blobs: f.blobs,
          extraction,
          ids: { next: () => uuid(1) },
        },
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.managed.size).toBe(1);
    expect(f.records.size).toBe(1);
    expect(f.records.get(uuid(1))?.extractedText).toBeNull();
  });
  it("persists extracted files within output bounds and attaches durable owner links", async () => {
    const f = setup();
    const item = await ingestAttachment(
      {
        name: "doc.pdf",
        mimeType: "application/pdf",
        byteLength: 10,
        sourceUri: "picker://1",
      },
      {
        blobs: f.blobs,
        extraction: f.extraction,
        ids: { next: () => uuid(1) },
      },
      {
        limits: {
          maxImageBytes: 100,
          maxDocumentBytes: 100,
          maxExtractedCharacters: 4,
          maxPdfPages: 3,
          maxXlsxEntries: 5,
          maxXlsxUncompressedBytes: 50,
        },
      },
    );
    expect(item.extractedText).toBe("boun");
    await retainAttachments(f.blobs, "message-7", [item.id, item.id]);
    expect(f.retained).toEqual(["message-7:" + item.id]);
  });
  it("maps images only to compatible vision models and returns blob references", async () => {
    const f = setup();
    const item = {
      id: uuid(2),
      blobRef: uuid(12),
      name: "a.jpg",
      mimeType: "image/jpeg",
      kind: "image",
      byteLength: 10,
      sha256: "b".repeat(64),
      extractedText: null,
      metadata: {},
    } as AttachmentDescriptor;
    await f.blobs.save(item);
    await expect(
      mapVisionAttachments([item.id], f.blobs, { images: false }),
    ).rejects.toMatchObject({ code: "vision-unsupported" });
    await expect(
      mapVisionAttachments([item.id], f.blobs, { images: true }),
    ).resolves.toEqual([
      {
        type: "image",
        attachmentId: item.id,
        blobRef: item.blobRef,
        mimeType: item.mimeType,
        byteLength: 10,
        detail: "auto",
      },
    ]);
  });
  it("offers a visible large-image retry and creates a metadata-preserving copy", async () => {
    const item = {
      id: uuid(3),
      blobRef: uuid(13),
      name: "large.jpg",
      mimeType: "image/jpeg",
      kind: "image",
      byteLength: 99,
      sha256: "c".repeat(64),
      extractedText: null,
      metadata: { orientation: 6 },
    } as AttachmentDescriptor;
    expect(
      await prepareOversizedImageRetry({ attachment: item, modelMaxBytes: 50 }),
    ).toMatchObject({ state: "retry-offered", targetBytes: 50 });
    let preserved = false;
    await expect(
      compressAndResend({
        attachment: item,
        modelMaxBytes: 50,
        compressor: {
          async compress(input) {
            preserved = input.preserveMetadata;
            return {
              uri: "managed-copy",
              mimeType: "image/jpeg",
              byteLength: 40,
              metadataPreserved: true,
            };
          },
          async replaceManaged() {
            return { ...item, id: uuid(4), blobRef: uuid(14), byteLength: 40 };
          },
        },
      }),
    ).resolves.toMatchObject({ id: uuid(4), byteLength: 40 });
    expect(preserved).toBe(true);
    await expect(
      compressAndResend({
        attachment: item,
        modelMaxBytes: 50,
        compressor: {
          async compress() {
            return {
              uri: "x",
              mimeType: item.mimeType,
              byteLength: 70,
              metadataPreserved: true,
            };
          },
          async replaceManaged() {
            return item;
          },
        },
      }),
    ).rejects.toMatchObject({ code: "too-large" });
  });
});
