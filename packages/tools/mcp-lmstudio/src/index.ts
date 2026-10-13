/**
 * LM Studio integrated-MCP bindings (T065 / TL-06, TL-07).
 *
 * LM Studio runs MCP servers configured in the host's own mcp.json and
 * exposes them to the native v1 chat API as plugin integrations, e.g.
 * `mcp/playwright`. A phone cannot read the host's mcp.json, so this app
 * stores the *names* the user says the host exposes, with friendly labels
 * and per-integration enablement. These pure helpers are the whole contract:
 * canonicalize a name, collect the references for a native request, and
 * translate missing/unavailable-plugin errors. Remote URL MCP servers are a
 * different mechanism entirely (packages/tools/mcp-http).
 */

/** One configured host integration: stable id, reference, display, toggle. */
export interface LmStudioIntegration {
  /** Stable local row id; renaming never changes it or the reference. */
  readonly id: string;
  /** Canonical plugin reference sent to LM Studio, e.g. `mcp/playwright`. */
  readonly name: string;
  /** Friendly display name, free-form; never sent to the server. */
  readonly label: string;
  readonly enabled: boolean;
}

const NAME_PATTERN = /^mcp\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Canonicalizes an integrated name. Plain server names from mcp.json become
 * their LM Studio plugin reference (`playwright` -> `mcp/playwright`);
 * already-qualified references pass through. URLs and path traversal are
 * rejected here because remote MCP belongs to the HTTP MCP path.
 */
export function normalizeLmStudioIntegrationName(
  raw: string,
): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const candidate = trimmed.startsWith("mcp/") ? trimmed : `mcp/${trimmed}`;
  return NAME_PATTERN.test(candidate) ? candidate : undefined;
}

export function isLmStudioIntegrationName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * The deduplicated reference list for a native v1 request, in configuration
 * order; disabled integrations are excluded.
 */
export function enabledLmStudioIntegrationRefs(
  integrations: readonly LmStudioIntegration[],
): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const integration of integrations) {
    if (!integration.enabled || !isLmStudioIntegrationName(integration.name))
      continue;
    if (seen.has(integration.name)) continue;
    seen.add(integration.name);
    refs.push(integration.name);
  }
  return refs;
}

/**
 * Integrated-MCP plugin support is LM Studio only. Ollama and arbitrary
 * OpenAI-compatible servers must never receive integration references, and
 * this function is the single source of truth for that claim.
 */
export function supportsLmStudioIntegratedMcp(kind: string): boolean {
  return kind === "lmstudio";
}

export interface LmStudioIntegrationFailure {
  /** Human explanation naming what LM Studio reported. */
  readonly message: string;
  /** Actionable recovery for the host, not the app. */
  readonly recovery: string;
}

/**
 * Translates LM Studio native-API plugin errors into an honest explanation.
 * Returns undefined for anything that is not a missing/unavailable-plugin
 * problem, so unrelated failures keep their original details.
 */
export function translateLmStudioIntegrationError(
  message: string,
): LmStudioIntegrationFailure | undefined {
  const missing = message.match(
    /(?:plugin|integration)\s+(?:with (?:id|name)\s+)?['"`]?((?:mcp\/)?[A-Za-z0-9][A-Za-z0-9._/-]*)['"`]?\s+(?:was not found|not found|does not exist|is not installed|is not available)/i,
  );
  if (missing?.[1]) {
    const name = normalizeLmStudioIntegrationName(missing[1]) ?? missing[1];
    return {
      message: `LM Studio does not have the integration “${name}”.`,
      recovery:
        "Open LM Studio, check that the MCP server is installed in its mcp.json, and match the name here to the name there.",
    };
  }
  if (
    /allow calling servers from mcp\.json|servers from mcp\.json.*(?:not|deny|disabled)|mcp\.json.*(?:not allowed|disabled)/i.test(
      message,
    )
  )
    return {
      message: "LM Studio is not allowed to call its own mcp.json servers.",
      recovery:
        "In LM Studio server settings, enable “Allow calling servers from mcp.json” and retry.",
    };
  if (
    /(?:mcp|plugin|integration)[^\n]{0,80}?(?:not enabled|disabled|unavailable)|failed to start (?:mcp|plugin)[^\n]{0,80}/i.test(
      message,
    )
  )
    return {
      message: "An LM Studio integration is unavailable right now.",
      recovery:
        "Open LM Studio, make sure the MCP server starts without errors, and retry.",
    };
  return undefined;
}
