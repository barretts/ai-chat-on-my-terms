import { describe, expect, it } from "vitest";
import type {
  AttachmentBlobPort,
  AttachmentDescriptor,
  ExtractionPort,
} from "@locallab/attachments";
import {
  chooseAttachment,
  openAttachmentPreview,
  takePhoto,
  type AttachmentPlatform,
} from "../src/index.js";

const uid = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
function harness(selection?: "photo" | "file") {
  const records = new Map<string, AttachmentDescriptor>();
  const blobs: AttachmentBlobPort = {
    async importManaged() {
      return { blobRef: uid(8), sha256: "d".repeat(64), byteLength: 12 };
    },
    async getManaged(ref) {
      return {
        uri: "managed://" + ref,
        mimeType: "image/jpeg",
        byteLength: 12,
      };
    },
    async save(item) {
      records.set(item.id, item);
    },
    async get(id) {
      return records.get(id);
    },
    async retain() {},
    async release() {},
  };
  const extraction: ExtractionPort = {
    async pdf() {
      return { text: "", pages: 0 };
    },
    async xlsx() {
      return { text: "", entries: 0, uncompressedBytes: 0 };
    },
    async text() {
      return "";
    },
  };
  const platform: AttachmentPlatform = {
    source: {
      async pickImage() {
        return selection === "photo"
          ? {
              name: "camera.jpg",
              mimeType: "image/jpeg",
              byteLength: 12,
              sourceUri: "camera://one",
            }
          : undefined;
      },
      async pickFile() {
        return selection === "file"
          ? {
              name: "file.jpg",
              mimeType: "image/jpeg",
              byteLength: 12,
              sourceUri: "picker://one",
            }
          : undefined;
      },
      async preview(ref) {
        return { uri: "preview://" + ref, mimeType: "image/jpeg" };
      },
    },
    blobs,
    extraction,
    ids: { next: () => uid(selection === "photo" ? 1 : 2) },
  };
  return { platform, records };
}
describe("native attachment bridge contract", () => {
  it("imports an optional camera selection into managed storage", async () => {
    const f = harness("photo");
    const image = await takePhoto(f.platform);
    expect(image).toMatchObject({ kind: "image", blobRef: uid(8) });
    expect(f.records.size).toBe(1);
    expect(await openAttachmentPreview(f.platform, image!)).toEqual({
      uri: "preview://" + uid(8),
      mimeType: "image/jpeg",
    });
  });
  it("imports optional file selection and treats picker cancellation as no attachment", async () => {
    const f = harness("file");
    expect(await chooseAttachment(f.platform)).toMatchObject({
      name: "file.jpg",
      kind: "image",
    });
    expect(await takePhoto(f.platform)).toBeUndefined();
  });
});
