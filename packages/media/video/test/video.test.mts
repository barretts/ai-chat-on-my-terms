import assert from "node:assert/strict";
import test from "node:test";
import { recognizeArtifact } from "../src/index.js";

function asciiBytes(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function u32beArr(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u32leArr(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function box(type: string, payload: number[]): number[] {
  return [...u32beArr(payload.length + 8), ...asciiBytes(type), ...payload];
}

function riffChunk(type: string, payload: number[]): number[] {
  return [
    ...asciiBytes(type),
    ...u32leArr(payload.length),
    ...payload,
    ...(payload.length % 2 === 1 ? [0] : []), // RIFF odd-size pad byte
  ];
}

test("animated GIF keeps gif mime and frame-delay duration", () => {
  const bytes = new Uint8Array([
    ...asciiBytes("GIF89a"),
    // two graphic-control extensions: 10 and 20 tenths of a second
    0x21, 0xf9, 0x04, 0xff, 0x0a, 0x00, 0x00,
    0x2c, 0, 0, 0, 0, 1, 1, 0, 0,
    0x21, 0xf9, 0x04, 0xff, 0x14, 0x00, 0x00,
    0x3b,
  ]);
  assert.deepEqual(recognizeArtifact("anim.gif", bytes), {
    kind: "video",
    mimeType: "image/gif",
    durationMs: 300,
  });
});

test("mp4 duration comes from mvhd (v0 and v1)", () => {
  const ftyp = box("ftyp", [
    ...asciiBytes("isom"),
    ...u32beArr(0),
    ...asciiBytes("isommp41"),
  ]);
  const mvhdV0 = box("mvhd", [
    0, 0, 0, 0, // version 0 + flags
    ...u32beArr(0), // creation
    ...u32beArr(0), // modification
    ...u32beArr(1000), // timescale
    ...u32beArr(4500), // duration
  ]);
  const moovV0 = box("moov", mvhdV0);
  assert.deepEqual(recognizeArtifact("clip.mp4", new Uint8Array([...ftyp, ...moovV0])), {
    kind: "video",
    mimeType: "video/mp4",
    durationMs: 4500,
  });

  const mvhdV1 = box("mvhd", [
    1, 0, 0, 0, // version 1 + flags
    ...u32beArr(0), ...u32beArr(0), // creation 64
    ...u32beArr(0), ...u32beArr(0), // modification 64
    ...u32beArr(25), // timescale
    ...u32beArr(0), ...u32beArr(50), // duration 64
  ]);
  const moovV1 = box("moov", mvhdV1);
  assert.deepEqual(recognizeArtifact("clip.mp4", new Uint8Array([...ftyp, ...moovV1])), {
    kind: "video",
    mimeType: "video/mp4",
    durationMs: 2000,
  });
});

test("animated webp is recognized as playable with summed ANMF duration", () => {
  const vp8x = riffChunk("VP8X", [
    0x02, // flags: animation present
    0, 0, 0, // reserved
    0xff, 0xff, 0x00, // canvas width minus one
    0xff, 0xff, 0x00, // canvas height minus one
    0x00, 0x00, 0x00, // infinite loop
  ]);
  const anmf = (durationMs: number) =>
    riffChunk("ANMF", [
      0, 0, 0, // x
      0, 0, 0, // y
      0xff, 0xff, 0x00, // width
      0xff, 0xff, 0x00, // height
      0, // reserved
      ...u32leArr(durationMs).slice(0, 3), // duration (24-bit LE)
      0, // reserved
    ]);
  const riffLen = 4 + vp8x.length + anmf(50).length + anmf(100).length;
  const bytes = new Uint8Array([
    ...asciiBytes("RIFF"),
    ...u32leArr(riffLen),
    ...asciiBytes("WEBP"),
    ...vp8x,
    ...anmf(50),
    ...anmf(100),
  ]);
  assert.deepEqual(recognizeArtifact("anim.webp", bytes), {
    kind: "video",
    mimeType: "video/webp",
    durationMs: 150,
  });
});

test("static webp stays an image", () => {
  const vp8 = riffChunk("VP8 ", [1, 2, 3]);
  const bytes = new Uint8Array([
    ...asciiBytes("RIFF"),
    ...u32leArr(4 + vp8.length),
    ...asciiBytes("WEBP"),
    ...vp8,
  ]);
  assert.deepEqual(recognizeArtifact("still.webp", bytes), {
    kind: "image",
    mimeType: "image/webp",
  });
});

test("animated PNG reports apng video with fcTL delays", () => {
  const pngChunk = (type: string, payload: number[]) => [
    ...u32beArr(payload.length),
    ...asciiBytes(type),
    ...payload,
    ...u32beArr(0), // CRC
  ];
  const fctl = () =>
    pngChunk("fcTL", [
      ...u32beArr(0), // sequence
      ...u32beArr(1), ...u32beArr(1), // width, height
      ...u32beArr(0), ...u32beArr(0), // x, y
      0, 1, // delay_num = 1
      0, 40, // delay_den = 40  -> 25 ms
      0, 0, // dispose, blend
    ]);
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", new Array(13).fill(0)),
    ...pngChunk("acTL", [...u32beArr(2), ...u32beArr(0)]),
    ...fctl(),
    ...fctl(),
    ...pngChunk("IEND", []),
  ]);
  assert.deepEqual(recognizeArtifact("anim.png", bytes), {
    kind: "video",
    mimeType: "image/apng",
    durationMs: 50,
  });
});

test("still png stays an image", () => {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...box("IHDR", new Array(13).fill(0)),
    ...box("IDAT", [1, 2, 3, 4]),
    ...box("IEND", []),
  ]);
  assert.deepEqual(recognizeArtifact("still.png", bytes), {
    kind: "image",
    mimeType: "image/png",
  });
});

test("extension fallback covers container-only outputs like webm", () => {
  assert.deepEqual(recognizeArtifact("clip.webm", new Uint8Array([0x1a, 0x45])), {
    kind: "video",
    mimeType: "video/webm",
  });
  assert.deepEqual(recognizeArtifact("note.txt", new Uint8Array([0x68, 0x69])), {
    kind: "unknown",
    mimeType: "application/octet-stream",
  });
});
