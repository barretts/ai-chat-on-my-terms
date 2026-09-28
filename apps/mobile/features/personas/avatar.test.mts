import { describe, expect, it } from "vitest";
import { createManagedPersonaAvatarPort } from "./avatar";
const id = (n: number) =>
  `0195c000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

describe("managed Persona avatar port (native picker fixture)", () => {
  it("accepts a managed image and releases rejected remote previews", async () => {
    const released: string[] = [];
    let uri = "file:///fixture-private/blobs/avatar.png";
    const port = createManagedPersonaAvatarPort({
      pickImage: async () => ({
        id: id(1),
        mimeType: "image/png",
        byteLength: 128,
      }),
      preview: async () => ({ uri, mimeType: "image/png" }),
      release: async (attachmentId, ownerId) => {
        released.push(`${attachmentId}:${ownerId}`);
      },
    });
    expect(await port.pick(id(2))).toEqual({ attachmentId: id(1), uri });
    uri = "https://example.invalid/avatar.png";
    await expect(port.pick(id(2))).rejects.toThrow("managed local storage");
    expect(released).toEqual([`${id(1)}:${id(2)}`]);
    expect(await port.resolve(id(1))).toBeUndefined();
    uri = "file://untrusted-host/share/avatar.png";
    await expect(port.pick(id(2))).rejects.toThrow("managed local storage");
  });
  it("rejects oversized or non-image bytes and treats cancellation as no change", async () => {
    const released: string[] = [];
    let image:
      | { id: string; mimeType: string; byteLength: number }
      | undefined = {
      id: id(1),
      mimeType: "image/jpeg",
      byteLength: 9 * 1024 * 1024,
    };
    const port = createManagedPersonaAvatarPort({
      pickImage: async () => image,
      preview: async () => ({
        uri: "file:///fixture-private/avatar",
        mimeType: "image/jpeg",
      }),
      release: async (attachmentId) => {
        released.push(attachmentId);
      },
    });
    await expect(port.pick(id(2))).rejects.toThrow("smaller than 8 MB");
    image = { id: id(1), mimeType: "text/html", byteLength: 10 };
    await expect(port.pick(id(2))).rejects.toThrow("image for this avatar");
    image = undefined;
    expect(await port.pick(id(2))).toBeUndefined();
    expect(released).toEqual([id(1), id(1)]);
  });
});
