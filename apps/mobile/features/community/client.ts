/** Device side of the community catalog (UI-02/AC-08). Public browse,
 * authenticated publish/import. Themes are re-validated on the device
 * before they can touch the theme store; catalog calls carry no chat
 * text — only the strict theme document. */

import type { SecureTokenPort } from "../account/client.ts";

export interface ThemeListing {
  id: string;
  slug: string;
  authorId: string;
  updatedAt: string;
  revisions: number;
}

export interface ThemeDetail {
  id: string;
  slug: string;
  revision: number;
  doc: unknown;
}

export interface VoicePackInfo {
  id: string;
  slug: string;
  name: string;
  vendor: string;
  modelLabel: string;
  languages: string[];
}

export class CatalogApiError extends Error {
  name = "CatalogApiError";
  status: number;
  code: string | null;
  constructor(status: number, code: string | null) {
    super(`catalog request failed: ${status}`);
    this.status = status;
    this.code = code;
  }
}

export interface CreateCommunityClientOptions {
  baseUrl: string;
  tokens: SecureTokenPort;
  fetchImpl?: typeof fetch;
}

export interface CommunityClient {
  listThemes(): Promise<ThemeListing[]>;
  getTheme(slugOrId: string): Promise<ThemeDetail>;
  publishTheme(
    slug: string,
    doc: unknown,
  ): Promise<{ slug: string; revision: number }>;
  listVoices(): Promise<VoicePackInfo[]>;
}

export function createCommunityClient(
  options: CreateCommunityClientOptions,
): CommunityClient {
  const doFetch = options.fetchImpl ?? fetch;

  async function call(
    path: string,
    init: { method: "GET" | "POST" } = { method: "GET" },
    body?: unknown,
  ): Promise<unknown> {
    const token = await options.tokens.get();
    const response = await doFetch(`${options.baseUrl}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => null)) as
      | { code?: string }
      | null;
    if (!response.ok)
      throw new CatalogApiError(
        response.status,
        typeof json?.code === "string" ? json.code : null,
      );
    return json;
  }

  return {
    async listThemes() {
      const res = (await call("/catalog/themes")) as {
        items: ThemeListing[];
      };
      return res.items;
    },
    async getTheme(slugOrId) {
      return (await call(`/catalog/themes/${slugOrId}`)) as ThemeDetail;
    },
    async publishTheme(slug, doc) {
      return (await call(
        "/catalog/themes",
        { method: "POST" },
        { slug, doc },
      )) as { slug: string; revision: number };
    },
    async listVoices() {
      const res = (await call("/catalog/voices")) as {
        items: VoicePackInfo[];
      };
      return res.items;
    },
  };
}
