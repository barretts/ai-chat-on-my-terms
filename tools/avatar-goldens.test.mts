import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "vitest";

/**
 * Golden pins for the 19 bundled starter-persona busts (T179 avatar work).
 * The web/native attachers stream these bytes through the blob store, so a
 * silently re-encoded asset (different dimensions or content) must fail here
 * before it reaches devices. Goldens were captured from the shipped files;
 * regenerate by hand-editing this map only together with an asset change.
 */
const GOLDENS: Record<
  string,
  { file: string; width: number; height: number; sha256: string }
> = {
  "gruff-mentor": {
    file: "gruff-mentor.png",
    width: 512,
    height: 512,
    sha256: "baaef7d923df30c0655bdcad2e259628c0ec10e4d6a5f9606c7c4283f51f46da",
  },
  sunbeam: {
    file: "sunbeam.png",
    width: 512,
    height: 512,
    sha256: "29b1281ffd1342c53091616cc7a4987a8b2b03d4b51c346f8ed003b4b70634b6",
  },
  butler: {
    file: "butler.png",
    width: 512,
    height: 512,
    sha256: "341b5df959c6b32daa41f755b8bf69568609f46c9cc8b5b94e74d36b71a4ac01",
  },
  "noir-detective": {
    file: "noir-detective.png",
    width: 512,
    height: 512,
    sha256: "c01a86685a894e8d2f340c80ec1a4be65ace325ab87709740c5ad7d823e32805",
  },
  schemer: {
    file: "schemer.png",
    width: 512,
    height: 512,
    sha256: "7b60b67a1a2ba6fca74e2e566b55fcb1d4f7841cb00d707e7334d646eb8874e3",
  },
  archivist: {
    file: "archivist.png",
    width: 512,
    height: 512,
    sha256: "70a6a105c6c5383c6612ff72ddd430922c03c74a21dde6a1c7ed488a58716826",
  },
  "hype-buddy": {
    file: "hype-buddy.png",
    width: 512,
    height: 512,
    sha256: "a2ec4628e447f5c9aff580d5f876523bf00271639c1968a006763fea16d3dbf8",
  },
  oracle: {
    file: "oracle.png",
    width: 512,
    height: 512,
    sha256: "2eb5743e497051705898e67c96843b38cf5a69ac5b00d650b3620ccb0c6aa2ba",
  },
  tsundere: {
    file: "tsundere.png",
    width: 512,
    height: 512,
    sha256: "5f670775cedd3e34d7f6737de86fb1aa6916d080a65af927c59254b920bd2be4",
  },
  kuudere: {
    file: "kuudere.png",
    width: 512,
    height: 512,
    sha256: "1f5c568d8196594172724a8bebad2e9cefb7f4b1b47c6d7ca94805122951f63c",
  },
  genki: {
    file: "genki.png",
    width: 512,
    height: 512,
    sha256: "a931f91604a2da2ddbb85d09a59a2c18eb9775310c4b7680b1e4b4faebd8c2c0",
  },
  chuunibyou: {
    file: "chuunibyou.png",
    width: 512,
    height: 512,
    sha256: "6a47c3e51cf351c1320468d0070b77f0d44669073355d7f9a11568d4fb2bc068",
  },
  "isekai-hero": {
    file: "isekai-hero.png",
    width: 512,
    height: 512,
    sha256: "21097246478a08e47cebb77436a7c24ee7c412dbe44c65ef3d11787bf3c05b05",
  },
  "magical-girl": {
    file: "magical-girl.png",
    width: 512,
    height: 512,
    sha256: "e909ca28d9c269d96ecaccb61f909de73aba462ab921bf97a23b55cdd4623a37",
  },
  "bench-pirate": {
    file: "bench-pirate.png",
    width: 512,
    height: 512,
    sha256: "8b4f155992b4a11998fd5c443950bc6ca2d42f6682ca80dee64aebb2203bd886",
  },
  "bench-poet": {
    file: "bench-poet.png",
    width: 512,
    height: 512,
    sha256: "e77f833110335757f4c69b33366c96b6bd2ab3166b5c561d05844cc58fe39ac4",
  },
  "bench-engineer": {
    file: "bench-engineer.png",
    width: 512,
    height: 512,
    sha256: "f562ab2ad6ba07fdf6f5c1b933b200ea51fa344eb1d5521175ec0779d3d3324b",
  },
  "bench-skeptic": {
    file: "bench-skeptic.png",
    width: 512,
    height: 512,
    sha256: "c6e2292007f69f50571541c47562db556a10262de027ee845761abd8c3d8d382",
  },
  "bench-chef": {
    file: "bench-chef.png",
    width: 512,
    height: 512,
    sha256: "7f25b639a2a302af216c8407366a4866e26d4ee191e64056e16d13fb42676bbc",
  },
};

const assetsDirectory = resolve(
  import.meta.dirname ?? ".",
  "../apps/mobile/assets/starter-personas",
);
const assetsSource = resolve(
  import.meta.dirname ?? ".",
  "../apps/mobile/platform/starter-avatars.assets.ts",
);

function decodePngHeader(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("every golden bust is a valid 512x512 PNG with pinned bytes", () => {
  for (const [key, golden] of Object.entries(GOLDENS)) {
    const bytes = readFileSync(resolve(assetsDirectory, golden.file));
    expect(decodePngHeader(bytes), key).toEqual({
      width: golden.width,
      height: golden.height,
    });
    expect(createHash("sha256").update(bytes).digest("hex"), key).toBe(
      golden.sha256,
    );
  }
});

test("the shared asset map and the goldens cover exactly the same keys", () => {
  const mapped = [
    ...readFileSync(assetsSource, "utf8").matchAll(
      /"?([a-z0-9-]+)"?:\s*require\("\.\.\/assets\/starter-personas\/([a-z0-9-]+)\.png"\)/g,
    ),
  ].map((match) => [match[1], match[2]]);
  expect(mapped.map(([key]) => key).sort()).toEqual(
    Object.keys(GOLDENS).sort(),
  );
  for (const [key, file] of mapped)
    expect(`${file}.png`, key).toBe(GOLDENS[key]!.file);
});
