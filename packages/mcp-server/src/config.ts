// Configuration for the Cobblr MCP server, read from the environment.
//
// The server authenticates to a Cobblr install with a long-lived API token
// (the `cbt_…` form minted at POST /me/api-tokens — see the README). Nothing is
// stored by this process; the token lives in the user's MCP client config.

export interface Config {
  /** Base URL of the Cobblr REST API, including the version prefix.
   *  e.g. "http://localhost:4000/api/v1" (self-host) or "https://app.cobblr.example/api/v1" (cloud). */
  baseUrl: string;
  /** A `cbt_…` API token (Authorization: Bearer). */
  token: string;
  /** Optional default workspace slug, so per-tool `workspace` args become optional. */
  defaultOrgSlug: string | null;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const rawBase = env.COBBLR_BASE_URL?.trim();
  const token = env.COBBLR_API_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "COBBLR_API_TOKEN is required. Mint one in Cobblr (Settings → API tokens, or POST /me/api-tokens) and set it in your MCP client config.",
    );
  }
  if (!token.startsWith("cbt_")) {
    // Not fatal — a session JWT also works — but the cbt_ token is the intended path.
    process.stderr.write(
      "[cobblr-mcp] warning: COBBLR_API_TOKEN does not look like a 'cbt_' API token; using it anyway.\n",
    );
  }

  // Default to a local dev install; cloud users override with COBBLR_BASE_URL.
  const baseUrl = stripTrailingSlash(rawBase || "http://localhost:4000/api/v1");

  return {
    baseUrl,
    token,
    defaultOrgSlug: env.COBBLR_ORG_SLUG?.trim() || null,
  };
}

/** Config for the REMOTE (Streamable-HTTP) server. Unlike the stdio server, the
 *  token is NOT read from the environment — it arrives per-request as a Bearer
 *  header, so one hosted process serves many users (each with their own token).
 *  Only the target install (baseUrl) and the listen port are process-level. */
export interface HttpConfig {
  baseUrl: string;
  port: number;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const baseUrl = stripTrailingSlash(env.COBBLR_BASE_URL?.trim() || "http://localhost:4000/api/v1");
  const port = Number(env.MCP_HTTP_PORT) || 8848;
  return { baseUrl, port };
}
