declare const secretRefBrand: unique symbol;
export type SecretRef = string & { readonly [secretRefBrand]: true };

export interface SecureValuePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SecretDescriptor {
  readonly ref: SecretRef;
  readonly host: string;
  readonly headerName: string;
}

export interface SecretStore {
  put(
    host: string,
    headerName: string,
    value: string,
  ): Promise<SecretDescriptor>;
  remove(ref: SecretRef): Promise<void>;
  resolveHeaders(
    host: string,
    refs: readonly SecretRef[],
  ): Promise<Readonly<Record<string, string>>>;
}

export class SecretStoreError extends Error {
  readonly code:
    | "invalid-host"
    | "invalid-header"
    | "host-mismatch"
    | "missing"
    | "secure-store";
  readonly cause?: unknown;
  constructor(code: SecretStoreError["code"], cause?: unknown) {
    const messages: Record<SecretStoreError["code"], string> = {
      "invalid-host": "Enter a complete HTTP or HTTPS server address.",
      "invalid-header": "Enter a valid HTTP header name.",
      "host-mismatch":
        "This credential belongs to a different server. Enter a key for this server address.",
      missing:
        "The saved credential is unavailable. Enter the key again in connection settings.",
      "secure-store":
        "The credential could not be stored or read securely. Try entering and saving it again.",
    };
    super(messages[code]);
    Object.defineProperty(this, "cause", { value: cause, enumerable: false });
    this.name = "SecretStoreError";
    this.code = code;
  }
}

export function normalizeHost(host: string): string {
  try {
    const url = new URL(host);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url.origin.toLowerCase();
  } catch {
    throw new SecretStoreError("invalid-host");
  }
}

function validateHeaderName(name: string): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
    throw new SecretStoreError("invalid-header");
  return name.toLowerCase();
}

function refKey(ref: SecretRef): string {
  if (!/^sec_[0-9a-f-]{36}$/i.test(ref)) throw new SecretStoreError("missing");
  return ref;
}

function defaultRandomUUID(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type IndexEntry = { readonly host: string; readonly headerName: string };

function readIndex(serialized: string): IndexEntry {
  try {
    const entry: unknown = JSON.parse(serialized);
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !("host" in entry) ||
      !("headerName" in entry) ||
      typeof entry.host !== "string" ||
      typeof entry.headerName !== "string"
    )
      throw new Error(
        "Saved credential ownership metadata is invalid. Enter and save the key again.",
      );
    return {
      host: normalizeHost(entry.host),
      headerName: validateHeaderName(entry.headerName),
    };
  } catch (cause) {
    throw new SecretStoreError("secure-store", cause);
  }
}

/** Values and the small ownership index share an OS-protected store. The index contains no values. */
export class HostScopedSecretStore implements SecretStore {
  private readonly prefix: string;
  constructor(
    private readonly secureStore: SecureValuePort,
    namespace: string,
    private readonly randomUUID: () => string = defaultRandomUUID,
  ) {
    if (!namespace.trim())
      throw new Error("A secure-store namespace is required");
    this.prefix = `locallab:${encodeURIComponent(namespace)}:secret:`;
  }

  async put(
    hostInput: string,
    headerNameInput: string,
    value: string,
  ): Promise<SecretDescriptor> {
    const host = normalizeHost(hostInput);
    const headerName = validateHeaderName(headerNameInput);
    if (!value || /[\r\n]/.test(value))
      throw new SecretStoreError("secure-store");
    const ref = refKey(`sec_${this.randomUUID()}` as SecretRef) as SecretRef;
    const entry: IndexEntry = { host, headerName };
    try {
      await this.secureStore.set(this.valueKey(ref), value);
      await this.secureStore.set(this.indexKey(ref), JSON.stringify(entry));
    } catch (cause) {
      // Either native write may have committed before returning an error.
      await Promise.allSettled([
        this.secureStore.delete(this.valueKey(ref)),
        this.secureStore.delete(this.indexKey(ref)),
      ]);
      throw new SecretStoreError("secure-store", cause);
    }
    return Object.freeze({ ref, host, headerName });
  }

  async remove(refInput: SecretRef): Promise<void> {
    const ref = refKey(refInput);
    try {
      await this.secureStore.delete(this.valueKey(ref));
      await this.secureStore.delete(this.indexKey(ref));
    } catch (cause) {
      throw new SecretStoreError("secure-store", cause);
    }
  }

  async resolveHeaders(
    hostInput: string,
    refs: readonly SecretRef[],
  ): Promise<Readonly<Record<string, string>>> {
    const host = normalizeHost(hostInput);
    const headers: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const rawRef of refs) {
      const ref = refKey(rawRef);
      let index: IndexEntry;
      let value: string | null;
      try {
        const storedIndex = await this.secureStore.get(this.indexKey(ref));
        if (storedIndex === null) throw new SecretStoreError("missing");
        index = readIndex(storedIndex);
        if (index.host !== host) throw new SecretStoreError("host-mismatch");
        value = await this.secureStore.get(this.valueKey(ref));
      } catch (error) {
        if (error instanceof SecretStoreError) throw error;
        throw new SecretStoreError("secure-store", error);
      }
      if (value === null) throw new SecretStoreError("missing");
      if (typeof value !== "string" || !value || /[\r\n]/.test(value))
        throw new SecretStoreError("secure-store");
      const name = validateHeaderName(index.headerName);
      if (name in headers) throw new SecretStoreError("invalid-header");
      headers[name] = value;
    }
    return Object.freeze(headers);
  }

  private valueKey(ref: string): string {
    return `${this.prefix}${ref}:value`;
  }
  private indexKey(ref: string): string {
    return `${this.prefix}${ref}:owner`;
  }
}

/** Scrub known values and secret-shaped fields before logs, diagnostics, or crash reports. */
export function redact(
  value: unknown,
  knownSecrets: readonly string[] = [],
): unknown {
  const replacements = knownSecrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      let output = item;
      for (const secret of replacements)
        output = output.split(secret).join("[REDACTED]");
      return output.replace(
        /(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
        "$1[REDACTED]",
      );
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) {
        if (
          /authorization|api[-_]?key|token|secret|credential|password|headers?/i.test(
            key,
          )
        )
          result[key] = "[REDACTED]";
        else result[key] = walk(child);
      }
      return result;
    }
    return item;
  };
  return walk(value);
}

/** Backups and support exports omit all credential material and opaque key references. */
export function exportWithoutSecrets<T>(value: T): T {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string" && /^sec_[0-9a-f-]{36}$/i.test(item)) {
      return undefined;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) {
        if (
          /authorization|api[-_]?key|token|secret|credential|password|headers?|credentialref|headerref/i.test(
            key,
          ) ||
          (typeof child === "string" && /^sec_[0-9a-f-]{36}$/i.test(child))
        )
          continue;
        output[key] = walk(child);
      }
      return output;
    }
    return item;
  };
  return walk(value) as T;
}
