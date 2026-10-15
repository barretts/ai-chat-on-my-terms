/** Device side of the support board (AC-05/AC-06/AC-07). Every write is
 * an explicit user action; the client has no path that sends conversation
 * content — requests carry only what the user typed, and diagnostics are
 * the redacted summary from ./redacted-diagnostics.ts, appended only
 * when the user opts in. */

import type { SecureTokenPort } from "../account/client.ts";

export type SupportKind = "feature-request" | "support-ticket";

export interface SupportRequestInfo {
  id: string;
  kind: SupportKind;
  title: string;
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  votes: number;
  myVote?: boolean | undefined;
  unreadReplies?: number | undefined;
}

export interface SupportCommentInfo {
  id: string;
  requestId: string;
  authorId: string;
  parentId: string | null;
  body: string;
  createdAt: string;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  createdAt: string;
}

export interface ChangelogInfo {
  version: string;
  notes: string;
  releasedAt: string;
}

export class SupportApiError extends Error {
  name = "SupportApiError";
  status: number;
  code: string | null;
  constructor(status: number, code: string | null) {
    super(`support request failed: ${status}`);
    this.status = status;
    this.code = code;
  }
}

export interface CreateSupportClientOptions {
  baseUrl: string;
  tokens: SecureTokenPort;
  fetchImpl?: typeof fetch;
}

export interface SupportClient {
  listRequests(): Promise<SupportRequestInfo[]>;
  getRequest(
    id: string,
  ): Promise<{
    request: SupportRequestInfo;
    comments: SupportCommentInfo[];
    attachments: AttachmentMeta[];
  }>;
  createRequest(input: {
    kind: SupportKind;
    title: string;
    body: string;
  }): Promise<string>;
  vote(id: string, up: boolean): Promise<{ votes: number }>;
  comment(
    id: string,
    input: { body: string; parentId?: string },
  ): Promise<string>;
  markRead(id: string): Promise<void>;
  addAttachment(
    id: string,
    input: { name: string; contentType: string; dataBase64: string },
  ): Promise<string>;
  changelog(): Promise<ChangelogInfo[]>;
  versionCheck(
    installedVersion: string,
  ): Promise<{ latest: string | null; upToDate: boolean }>;
  deleteAccount(): Promise<void>;
}

export function createSupportClient(
  options: CreateSupportClientOptions,
): SupportClient {
  const doFetch = options.fetchImpl ?? fetch;

  async function call(
    path: string,
    init: { method: "GET" | "POST" | "DELETE" } = { method: "GET" },
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
      throw new SupportApiError(
        response.status,
        typeof json?.code === "string" ? json.code : null,
      );
    return json;
  }

  return {
    async listRequests() {
      const res = (await call("/support/requests")) as {
        items: SupportRequestInfo[];
      };
      return res.items;
    },
    async getRequest(id) {
      return (await call(`/support/requests/${id}`)) as {
        request: SupportRequestInfo;
        comments: SupportCommentInfo[];
        attachments: AttachmentMeta[];
      };
    },
    async createRequest(input) {
      const res = (await call(
        "/support/requests",
        { method: "POST" },
        input,
      )) as { id: string };
      return res.id;
    },
    async vote(id, up) {
      return (await call(
        `/support/requests/${id}/vote`,
        { method: "POST" },
        { up },
      )) as { votes: number };
    },
    async comment(id, input) {
      const res = (await call(
        `/support/requests/${id}/comments`,
        { method: "POST" },
        input,
      )) as { id: string };
      return res.id;
    },
    async markRead(id) {
      await call(`/support/requests/${id}/read`, { method: "POST" });
    },
    async addAttachment(id, input) {
      const res = (await call(
        `/support/requests/${id}/attachments`,
        { method: "POST" },
        input,
      )) as { id: string };
      return res.id;
    },
    async changelog() {
      const res = (await call("/support/changelog")) as {
        items: ChangelogInfo[];
      };
      return res.items;
    },
    async versionCheck(installedVersion) {
      return (await call(
        `/support/version?app=${encodeURIComponent(installedVersion)}`,
      )) as { latest: string | null; upToDate: boolean };
    },
    async deleteAccount() {
      await call("/support/account", { method: "DELETE" });
    },
  };
}
