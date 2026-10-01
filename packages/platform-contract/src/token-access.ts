// The access levels a personal API token can carry, the words a person reads
// for each, and the rule for what each may reach. One copy for the api (which
// enforces it in requireAuth), the web (which offers the levels) and the MCP
// server a person runs on their own machine (which offers only the tools its
// token can run), so none of them can disagree with the server.

export const TOKEN_ACCESS = ["look", "change", "full"] as const;
export type TokenAccess = (typeof TOKEN_ACCESS)[number];

export function isTokenAccess(v: unknown): v is TokenAccess {
  return typeof v === "string" && (TOKEN_ACCESS as readonly string[]).includes(v);
}

export const TOKEN_ACCESS_LABEL: Record<TokenAccess, string> = {
  look: "Look only",
  change: "Look and make changes",
  full: "Full access",
};

export const TOKEN_ACCESS_MEANS: Record<TokenAccess, string> = {
  look: "Reads records. Changes nothing.",
  change: "Reads, adds, edits and moves records, and runs actions. Never touches settings, members, connections or other tokens. When an AI assistant uses it, deletes and anything that cannot be undone always ask you first.",
  full: "Everything you can do yourself, including settings and minting other tokens. When an AI assistant uses it, deletes and anything that cannot be undone always ask you first.",
};

/** What a new token starts as, wherever one is minted from a screen: the
 *  workspace in front of the person, able to make changes, never full. */
export const DEFAULT_TOKEN_ACCESS: TokenAccess = "change";

// ── What a token held to a workspace and an access level may reach ─────────
//
// Every personal token used to be the whole account: every workspace, every
// verb. A token given to an AI assistant or a script for one job carried all
// of it. A token can now name ONE workspace and one of three access levels,
// and this is the one place that says what those mean; requireAuth applies it
// before any handler runs, so the boundary is server-side whatever the client
// does.
//
//   look    read only. GET, and nothing that carries a credential.
//   change  look, plus changing RECORDS: a module or instance route, or
//           running an action. Never the workspace's settings, members,
//           modules or credentials, and never minting another token.
//   full    everything the owner can do, within the workspace if it names one.
//
// A token with neither column set (every token minted before this) is full
// access to every workspace, unchanged.

/** Routes that carry a credential or say who may do what. A token below
 *  `full` never reaches them, even to read: a token that can read an AI
 *  connection's settings or the member list is a token that can leak them. */
const GUARDED = /\/(connections|api-tokens|integrations|members|invites|roles|permissions|ai-settings|settings)(\/|$)/;

/** The one platform write a `change` token may make beside record routes. */
const CHANGE_PLATFORM_WRITES = new Set(["/actions/invoke"]);

export type TokenAccessVerdict = { ok: true } | { ok: false; code: string; message: string };

export function tokenAccessAllows(
  grant: { access: TokenAccess | null; orgSlug: string | null },
  method: string,
  originalUrl: string,
): TokenAccessVerdict {
  const access: TokenAccess = grant.access ?? "full";
  const path = (originalUrl.split("?")[0] ?? "").replace(/\/+$/, "");
  const m = /^\/api\/v1\/orgs\/([^/]+)(\/.*)?$/.exec(path);
  const read = method === "GET" || method === "HEAD";

  if (!m) {
    // Outside any workspace: who am I, and which workspaces are mine. A token
    // below full reaches nothing else here: not other tokens, not the account.
    const who = read && (path === "/api/v1/me" || path === "/api/v1/orgs");
    if (grant.orgSlug && !who) {
      return { ok: false, code: "token_workspace_only", message: `This token is for the ${grant.orgSlug} workspace only.` };
    }
    if (access !== "full" && !who) {
      return { ok: false, code: "token_access", message: accessMessage(access) };
    }
    return { ok: true };
  }

  const slug = decodeURIComponent(m[1] ?? "");
  const rel = m[2] ?? "";
  if (grant.orgSlug && slug !== grant.orgSlug) {
    return { ok: false, code: "token_workspace_only", message: `This token is for the ${grant.orgSlug} workspace only.` };
  }
  if (access === "full") return { ok: true };
  if (rel.includes("..") || GUARDED.test(rel)) {
    return { ok: false, code: "token_access", message: accessMessage(access) };
  }
  if (read) return { ok: true };
  if (access === "look") return { ok: false, code: "token_access", message: accessMessage(access) };
  if (CHANGE_PLATFORM_WRITES.has(rel)) return { ok: true };
  if (/^\/(modules|instances)\/[a-z0-9_-]+\/.+/i.test(rel)) return { ok: true };
  return { ok: false, code: "token_access", message: accessMessage(access) };
}

function accessMessage(access: TokenAccess): string {
  return access === "look"
    ? "This token can look but not change anything."
    : "This token can change records and run actions, not the workspace's settings, members or credentials.";
}
