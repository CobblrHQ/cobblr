// The access levels a personal API token can carry, the words a person reads
// for each, and the rule for what each may reach. One copy for the api (which
// enforces it in requireAuth), the web (which offers the levels) and the MCP
// server a person runs on their own machine (which offers only the tools its
// token can run), so none of them can disagree with the server.

import { moduleWriteChanges } from "@cobblr/platform-contract/module-write-changes";

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
  change: "Reads, adds, edits and moves records, and runs actions on them. Never touches the workspace itself (its name, settings, features, lists, fields or automations), members, connections, devices and stations, public links or other tokens. When an AI assistant uses it, deletes and anything that cannot be undone always ask you first.",
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
//   change  look, plus changing RECORDS: a module route its module calls a
//           record write (module-write-changes.ts), an instance's records, or
//           running an action. Never the workspace's settings, members,
//           modules, connections or public links, and never minting another
//           token.
//   full    everything the owner can do, within the workspace if it names one.
//
// A token with neither column set (every token minted before this) is full
// access to every workspace, unchanged.

/** Routes that carry a credential or say who may do what. A token below
 *  `full` never reaches them, even to read: a token that can read an AI
 *  connection's settings or the member list is a token that can leak them. */
const GUARDED = /\/(connections|api-tokens|integrations|members|invites|roles|permissions|ai-settings|settings)(\/|$)/;

/** Module routes a token below `full` never reaches, even to read: the whole
 *  integrations module, whose settings and call log name the workspace's
 *  connections. What a module's writes may reach is module-write-changes.ts. */
const CREDENTIAL_MODULE_ROUTES: RegExp[] = [
  /^\/modules\/core-integrations(\/|$)/,
];

/** Every module API file that encrypts or stores a credential, and the route a
 *  token below `full` must not write through it (or that it only reads). A test
 *  scans modules/*\/src/api and fails on a file that handles a credential and is
 *  not here, so a new one is classified when it is written, not after a review
 *  finds the hole. */
export const CREDENTIAL_ROUTE_FILES: Record<string, string> = {
  "modules/core-integrations/src/api/connectors.ts": "PATCH /api/v1/orgs/x/modules/core-integrations/connectors/c1",
  "modules/core-integrations/src/api/sync.ts": "PATCH /api/v1/orgs/x/modules/core-integrations/sync/connections/c1",
  "modules/core-integrations/src/api/test-connection-action.ts": "reads-only",
  "modules/core-ai/src/api/providers.ts": "PATCH /api/v1/orgs/x/modules/core-ai/providers/p1",
  "modules/core-print/src/api/index.ts": "PATCH /api/v1/orgs/x/modules/core-print/printers/p1",
  "modules/digifab/src/api/connections.ts": "PATCH /api/v1/orgs/x/modules/digifab/connections/c1",
  "modules/digifab/src/families/printers/api/print-rules.ts": "PATCH /api/v1/orgs/x/modules/digifab/print-rules/channels/ch1",
  "modules/digifab/src/families/printers/api/failure.ts": "PATCH /api/v1/orgs/x/modules/digifab/failure/detectors/d1",
  "modules/digifab/src/families/printers/api/bambu-lan-access.ts": "PUT /api/v1/orgs/x/modules/digifab/fleet/c1/d1/lan",
  "modules/inventory/src/api/spoolman.ts": "PATCH /api/v1/orgs/x/modules/inventory/spoolman/connections/c1",
};

/** Whether the query asks for secrets in the clear. Read the way the server
 *  will read it, not the way it was typed: names and values are percent-decoded
 *  (`include_%73ecrets=%74rue`), a name is case-blind and loses a trailing `[]`
 *  (a framework's query parser reads `include_secrets[]=true` as the same
 *  parameter), and when the name is repeated any one of them can be the one
 *  that counts. Fails closed: anything but an explicit "false" or "0" is a yes. */
function wantsSecrets(query: string): boolean {
  let pairs: Array<[string, string]>;
  try {
    pairs = [...new URLSearchParams(query).entries()];
  } catch {
    return true;
  }
  return pairs.some(([name, value]) => {
    if (name.trim().toLowerCase().replace(/\[[^\]]*\]$/, "") !== "include_secrets") return false;
    return !["false", "0"].includes(value.trim().toLowerCase());
  });
}

/** The path as the router will route it, for matching: percent-decoded, doubled
 *  slashes made one, the trailing slash dropped, and lower case, because the
 *  router ignores case. Null when it cannot be decoded: that is refused. */
function routedPath(rawPath: string): string | null {
  try {
    return decodeURIComponent(rawPath).replace(/\/{2,}/g, "/").replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

/** The kernel's own routes under a module's or a list's path. They change
 *  the workspace (its features, its lists), not its records, so the "a module
 *  or instance route is a record write" allowance must not reach them (#7138).
 *  A test holds every kernel write under those paths to a decision: each names
 *  its platform action, whose `changes` says which it is. */
const KERNEL_WORKSPACE_WRITES: RegExp[] = [
  /^\/modules\/[^/]+\/(enable|disable)$/,
  /^\/instances\/[^/]+\/(promote-category|demote-to-category|scan-fallback)$/,
];

/** The one platform write a `change` token may make beside record routes. The
 *  invoke route refuses it the actions that change the workspace itself. */
const CHANGE_PLATFORM_WRITES = new Set(["/actions/invoke"]);
/** Reads sent as a POST for their body: the explanation a refusal carries,
 *  asked ahead of it (a station's card, #8845). */
const POST_READS = new Set(["/approval-requests/describe"]);
const STATION_PICK = /^\/station-devices\/crew\/[a-z0-9][a-z0-9-]{0,39}\/pick$/;

export type TokenAccessVerdict = { ok: true } | { ok: false; code: string; message: string };

export function tokenAccessAllows(
  grant: { access: TokenAccess | null; orgSlug: string | null },
  method: string,
  originalUrl: string,
): TokenAccessVerdict {
  const access: TokenAccess = grant.access ?? "full";
  const [rawPath = "", ...queryParts] = originalUrl.split("?");
  const query = queryParts.join("?");
  const routed = routedPath(rawPath);
  // A path that cannot be read is refused to anything below full.
  if (routed === null) {
    return access === "full" && !grant.orgSlug ? { ok: true } : { ok: false, code: "token_access", message: accessMessage(access) };
  }
  const path = routed;
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

  const slug = m[1] ?? "";
  const rel = m[2] ?? "";
  if (grant.orgSlug && slug !== grant.orgSlug.toLowerCase()) {
    return { ok: false, code: "token_workspace_only", message: `This token is for the ${grant.orgSlug} workspace only.` };
  }
  if (access === "full") return { ok: true };
  if (rel.includes("..") || GUARDED.test(rel) || wantsSecrets(query) || CREDENTIAL_MODULE_ROUTES.some((r) => r.test(rel))) {
    return { ok: false, code: "token_access", message: accessMessage(access) };
  }
  if (read || (method === "POST" && POST_READS.has(rel))) return { ok: true };
  if (KERNEL_WORKSPACE_WRITES.some((r) => r.test(rel))) return { ok: false, code: "token_access", message: accessMessage(access) };
  if (access === "look") return { ok: false, code: "token_access", message: accessMessage(access) };
  if (CHANGE_PLATFORM_WRITES.has(rel)) return { ok: true };
  // A shared screen naming who works at it, and ending that pick (#8845): a
  // hand-over between people, not a setting. The route lets through only
  // that station's own token.
  if ((method === "POST" || method === "DELETE") && STATION_PICK.test(rel)) return { ok: true };
  // A module's route is a record write only where its module says so
  // (module-write-changes.ts); one nothing names is refused.
  const mod = /^\/modules\/([a-z0-9_-]+)(\/.+)$/.exec(rel);
  if (mod) {
    return moduleWriteChanges(mod[1] ?? "", method, mod[2] ?? "") === "records" ? { ok: true } : { ok: false, code: "token_access", message: accessMessage(access) };
  }
  if (/^\/instances\/[a-z0-9_-]+\/.+/i.test(rel)) return { ok: true };
  return { ok: false, code: "token_access", message: accessMessage(access) };
}

/** What a token below full is told when it is refused. */
export function accessMessage(access: TokenAccess): string {
  return access === "look"
    ? "This token can look but not change anything."
    : "This token can change records and run actions, not the workspace's settings, members or credentials.";
}
