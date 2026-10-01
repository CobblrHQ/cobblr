// Which tools this server offers, decided by the token it runs with.
//
// A person can mint a token held to one workspace and to looking only, and
// hand it to an assistant. This server used to offer that assistant every
// tool anyway: installing a bundle, applying a draft, creating and deleting
// records. The API refused each one, so the model saw a list of tools that
// always fail, which reads as a broken connector rather than as a boundary.
//
// So the server asks the API what its token may do (GET /me reports it) and
// offers only what the same rule the API enforces would allow
// (@cobblr/platform-contract/token-access). Each tool of this server's own
// declares the one request it makes, below; the test runs every offered tool
// and checks the request it really makes against the declaration and the
// rule, so the two cannot drift.

import { tokenAccessAllows, type TokenAccess } from "@cobblr/platform-contract/token-access";
import { lookOnlyCanRun, type WorkspaceTool } from "@cobblr/workspace-tools";

/** What the token may reach: its access level, and the one workspace it is
 *  held to (null for every workspace the person is in). */
export interface TokenGrant {
  access: TokenAccess;
  workspace: string | null;
}

/** A token with no limits, or an API too old to say: the API still enforces,
 *  so offering everything is only as wrong as it always was. */
export const FULL_GRANT: TokenGrant = { access: "full", workspace: null };

/** The request each of this server's own tools makes, relative to the REST
 *  root, `:slug` standing for the workspace. */
export const REACH: Record<string, { method: "GET" | "POST"; path: string }> = {
  cobblr_list_workspaces: { method: "GET", path: "/orgs" },
  cobblr_list_templates: { method: "GET", path: "/orgs/:slug/modules/core-authoring/templates" },
  cobblr_match_template: { method: "POST", path: "/orgs/:slug/modules/core-authoring/match-template" },
  cobblr_get_template: { method: "GET", path: "/orgs/:slug/modules/core-authoring/templates/:id" },
  cobblr_authoring_context: { method: "POST", path: "/orgs/:slug/modules/core-authoring/context" },
  cobblr_authoring_compile: { method: "POST", path: "/orgs/:slug/modules/core-authoring/compile" },
  cobblr_authoring_candidate: { method: "POST", path: "/orgs/:slug/modules/core-authoring/drafts/:id/candidate" },
  cobblr_authoring_repair_prompt: { method: "POST", path: "/orgs/:slug/modules/core-authoring/drafts/:id/repair-prompt" },
  cobblr_authoring_apply: { method: "POST", path: "/orgs/:slug/modules/core-authoring/drafts/:id/apply" },
  cobblr_authoring_list_drafts: { method: "GET", path: "/orgs/:slug/modules/core-authoring/drafts" },
  cobblr_authoring_get_draft: { method: "GET", path: "/orgs/:slug/modules/core-authoring/drafts/:id" },
  cobblr_validate_bundle: { method: "POST", path: "/orgs/:slug/bundles/validate" },
  cobblr_install_bundle: { method: "POST", path: "/orgs/:slug/bundles/install" },
  cobblr_drive_request_window: { method: "POST", path: "/orgs/:slug/drive/driver/request" },
  cobblr_drive_navigate: { method: "POST", path: "/orgs/:slug/drive/driver/navigate" },
  cobblr_drive_point: { method: "POST", path: "/orgs/:slug/drive/driver/present" },
  cobblr_drive_observe: { method: "GET", path: "/orgs/:slug/drive/driver/observe" },
};

/** The workspace a check is made against: the token's own, else the one the
 *  person configured, else a stand-in (a token for every workspace is judged
 *  the same in each). */
function checkSlug(grant: TokenGrant, defaultSlug: string | null): string {
  return grant.workspace ?? defaultSlug ?? "any";
}

/** Would the API let this token make this request? The API's own rule. */
export function grantAllows(grant: TokenGrant, method: string, restPath: string): boolean {
  return tokenAccessAllows({ access: grant.access, orgSlug: grant.workspace }, method, `/api/v1${restPath}`).ok;
}

/** Offer one of this server's own tools? A tool with no REACH entry is a
 *  programming error: it would be offered without anyone having asked. */
export function offersOwnTool(name: string, grant: TokenGrant, defaultSlug: string | null): boolean {
  const reach = REACH[name];
  if (!reach) throw new Error(`[cobblr-mcp] ${name} declares no REACH entry (offers.ts); say which request it makes`);
  const path = reach.path.replace(":slug", encodeURIComponent(checkSlug(grant, defaultSlug))).replace(":id", "x");
  return grantAllows(grant, reach.method, path);
}

/** Offer a shared workspace tool? The same rule the hosted endpoint applies
 *  to a token held to looking: no writes, and no read that has to POST. */
export function offersWorkspaceTool(tool: Pick<WorkspaceTool, "name" | "mode">, grant: TokenGrant): boolean {
  if (grant.access === "look" && !lookOnlyCanRun(tool)) return false;
  // A shared tool that writes a platform route (not a record, not an action)
  // says which, and is offered only to a token the API lets make it.
  const reach = WORKSPACE_TOOL_REACH[tool.name];
  if (!reach) return true;
  return grantAllows(grant, reach.method, reach.path.replace(":slug", encodeURIComponent(grant.workspace ?? "workspace")));
}

/** Shared tools whose write is a platform route rather than a record or an
 *  action: a `change` token may not make it, so it is not offered one. */
export const WORKSPACE_TOOL_REACH: Record<string, { method: "GET" | "POST"; path: string }> = {
  invoke_service: { method: "POST", path: "/orgs/:slug/services/jobs" },
};

/** Read the grant from the API. An API that does not report one is older
 *  than the field; it still enforces, so this offers everything. */
export function grantFromMe(me: unknown): TokenGrant {
  const token = (me as { token?: { access?: unknown; workspace?: unknown } | null } | null)?.token;
  if (!token) return FULL_GRANT;
  const access = token.access === "look" || token.access === "change" ? token.access : "full";
  return { access, workspace: typeof token.workspace === "string" && token.workspace ? token.workspace : null };
}
