import { Directory, File, Paths } from "expo-file-system";
import {
  createGrammarGuard,
  type GrammarGuard,
  type GrammarGuardStorage,
} from "@locallab/gguf-ios";

/**
 * Keep in sync with the `llama.rn` dependency version (apps/mobile
 * package.json). Bumping llama.rn changes the guard namespace so quarantine
 * entries recorded against the old native build stop suppressing JSON mode —
 * upgrade fixes take effect automatically.
 */
export const LLAMA_RN_GUARD_VERSION = "llama-rn-0.12.4";

const guardDirectory = () => {
  const directory = new Directory(Paths.document, "locallab", "grammar-guard");
  directory.create({ intermediates: true, idempotent: true });
  return directory;
};

const storage: GrammarGuardStorage = {
  async read<T>(name: string): Promise<T | undefined> {
    const file = new File(guardDirectory(), name);
    if (!file.exists) return undefined;
    try {
      return JSON.parse(await file.text()) as T;
    } catch {
      return undefined;
    }
  },
  async write(name: string, value: unknown): Promise<void> {
    const file = new File(guardDirectory(), name);
    file.create({ overwrite: true });
    file.write(JSON.stringify(value));
  },
  async remove(name: string): Promise<void> {
    const file = new File(guardDirectory(), name);
    if (file.exists) file.delete();
  },
  async list(prefix: string): Promise<string[]> {
    return guardDirectory()
      .list()
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => entry.name);
  },
};

let guard: GrammarGuard | undefined;

/** Process-wide grammar guard (durable per-device state lives in app documents). */
export function getGrammarGuard(): GrammarGuard {
  guard ??= createGrammarGuard({
    storage,
    guardVersion: LLAMA_RN_GUARD_VERSION,
    log: (message) => console.warn(`[grammar-guard] ${message}`),
  });
  return guard;
}
