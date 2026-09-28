// What a personal API token held to a workspace and an access level may reach.
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

import { type TokenAccess } from "@cobblr/platform-contract/token-access";

export { TOKEN_ACCESS, isTokenAccess, type TokenAccess } from "@cobblr/platform-contract/token-access";

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
