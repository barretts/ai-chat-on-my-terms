const knownSecrets = new Set<string>();

/** Called at the secure-storage boundary; values never leave this module. */
export function registerDiagnosticSecret(value: string): void {
  if (value) {
    knownSecrets.add(value);
    const credential = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
    if (credential) knownSecrets.add(credential);
  }
}

export function sanitizeDiagnosticText(value: string): string {
  let text = value;
  for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) {
    for (const representation of new Set([
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ]))
      text = text.split(representation).join("[REDACTED]");
  }
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[REDACTED URL]";
      }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
    .replace(
      /((?:api[-_ ]?key|x-api-key|password|token|secret|authorization|x-subscription-token)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsec_[0-9a-f-]{36}\b/gi, "[REDACTED REF]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

/** Trace transport metadata contains the origin only, never a URL path/query. */
export function diagnosticOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return /^(https?:)$/.test(url.protocol)
      ? sanitizeDiagnosticText(url.origin)
      : undefined;
  } catch {
    return undefined;
  }
}
