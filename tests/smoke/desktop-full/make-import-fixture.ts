// Writes a valid locallab chat-archive ZIP for the desktop import smoke.
// The bytes go through the app's own exporter (exportAllChatsZip + the same
// ZipPort the app ships), so a format drift would fail app-side validation
// rather than silently skewing the test. Usage: tsx make-import-fixture.ts <out.zip>
import fs from "node:fs";
import path from "node:path";
import { exportAllChatsZip } from "../../../packages/archives/src/index";
import { mobileArchiveZip } from "../../../apps/mobile/composition/chat/archives/zip";

const conversation = {
  id: "import-fixture-conversation",
  title: "Imported smoke transcript",
  createdAt: "2026-10-19T09:00:00.000Z",
  messages: [
    {
      id: "import-fixture-user",
      role: "user",
      parts: [{ type: "text", text: "Imported smoke question." }],
    },
    {
      id: "import-fixture-assistant",
      role: "assistant",
      parts: [{ type: "text", text: "Desktop import fixture line." }],
    },
  ],
};

async function main() {
  const [, , outPath] = process.argv;
  if (!outPath) throw new Error("usage: tsx make-import-fixture.ts <out.zip>");
  const bytes = await exportAllChatsZip([conversation], [], mobileArchiveZip);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, bytes);
  console.log(`wrote ${bytes.byteLength} bytes to ${outPath}`);
}
main();
