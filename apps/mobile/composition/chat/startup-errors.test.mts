import { expect, it } from "vitest";
import { chatStartupError } from "./startup-errors";

it("explains the browser's exclusive database handle without mislabeling other failures", () => {
  const conflict = new Error(
    "createSyncAccessHandle cannot run with another open Access Handle",
  );
  conflict.name = "NoModificationAllowedError";
  expect(chatStartupError(conflict, "web")).toContain("Close that tab");
  expect(chatStartupError(conflict, "ios")).toContain(
    "Chat storage could not be opened",
  );
  expect(chatStartupError(new Error("Disk full"), "web")).toContain(
    "Chat storage could not be opened",
  );
});
