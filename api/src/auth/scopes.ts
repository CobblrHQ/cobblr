// Capability scopes for API tokens. A token minted with a non-empty `scopes`
// array is DENY-by-default: requireAuth clamps it to the union of the route
// allowlists for those scopes, so a "feedback:triage" token can ONLY hit the
// feedback queue — never token minting, tenant data, or any other admin
// surface, even though it carries the (possibly super-admin) user's identity.
//
// This mirrors the H1 Tier-B app-token clamp (`appTokenPathAllowed` in
// middleware.ts): the boundary lives server-side, not just in the client.
//
// Adding a scope: append a TokenScopeDef with tight [method, path-regex] rules.
// Paths are relative to /api/v1 (no host, no /api/v1 prefix, no query, no
// trailing slash). Keep rules as narrow as the use-case — broad rules defeat
// the point.

export interface TokenScopeDef {
  key: string;
  label: string;
  description: string;
  /** Allow rules: [HTTP method, regex tested against the /api/v1-relative path]. */
  allow: Array<[string, RegExp]>;
}

export const TOKEN_SCOPES: TokenScopeDef[] = [
  {
    key: "devices:edge",
    label: "Edge bridge",
    description:
      "Let an on-site edge bridge dial in and relay machine commands for this " +
      "workspace (register / poll / respond / status) and self-update its own code " +
      "(release). No other access — safe to hand to a bridge running on a Pi/NAS/mini-PC.",
    allow: [
      // The generic kernel wire (canonical since the edge surface moved out of
      // digifab) AND the historic digifab alias — field bridges installed
      // before the move keep polling + self-updating without a reinstall.
      ["POST", /^\/orgs\/[^/]+\/edge\/(register|respond)$/],
      ["GET", /^\/orgs\/[^/]+\/edge\/(poll|status|release|release\/bundle|release\/loader)$/],
      ["POST", /^\/orgs\/[^/]+\/modules\/digifab\/edge\/(register|respond)$/],
      // poll/status + the self-update endpoints the loader fetches (release + its bundle).
      ["GET", /^\/orgs\/[^/]+\/modules\/digifab\/edge\/(poll|status|release|release\/bundle)$/],
    ],
  },
  {
    key: "feedback:triage",
    label: "Feedback triage",
    description:
      "Read the platform feedback queue and resolve / notify reporters. Nothing else.",
    allow: [
      ["GET", /^\/super-admin\/feedback(\/.*)?$/],
      ["PATCH", /^\/super-admin\/feedback\/[^/]+$/],
      // Close several items at once with ONE combined reporter email/notif.
      ["POST", /^\/super-admin\/feedback\/batch-resolve$/],
    ],
  },
  {
    key: "scan:eval",
    label: "Scan eval harness",
    description:
      "Run the matchmaker prompt-eval endpoint + read/prune captured eval cases " +
      "(scan-eval, scan-eval-cases). No other admin surface.",
    allow: [
      ["POST", /^\/super-admin\/scan-eval$/],
      ["GET", /^\/super-admin\/scan-eval-cases$/],
      ["DELETE", /^\/super-admin\/scan-eval-cases\/[^/]+\/[^/]+$/],
    ],
  },
  {
    key: "authoring:eval",
    label: "Bundle-authoring eval harness",
    description:
      "Run the bundle-authoring prompt-eval endpoint (POST /super-admin/authoring-eval). " +
      "No DB writes, no other admin surface.",
    allow: [["POST", /^\/super-admin\/authoring-eval$/]],
  },
  {
    key: "feedback:ingest",
    label: "Feedback ingest (Discord bot)",
    description:
      "Submit a feedback ticket + append follow-up messages from an external " +
      "channel (the Discord support bot), and resolve a ticket when the reporter " +
      "clicks the bot's 'close' button. Can ONLY create/append/close-own — never " +
      "read or triage.",
    allow: [
      ["POST", /^\/super-admin\/feedback\/ingest$/],
      ["POST", /^\/super-admin\/feedback\/append$/],
      ["POST", /^\/super-admin\/feedback\/append-dm$/],
      ["POST", /^\/super-admin\/feedback\/resolve-by-thread$/],
    ],
  },
  {
    key: "waitlist:ingest",
    label: "Waitlist ingest (marketing site)",
    description:
      "Submit a waitlist signup from the marketing site's form (the cobblr.xyz " +
      "Pages Function). Can ONLY create signups — never read, approve, or dismiss.",
    allow: [["POST", /^\/super-admin\/waitlist\/ingest$/]],
  },
  {
    key: "waitlist:approve",
    label: "Waitlist approve (Discord admin bot)",
    description:
      "Approve or dismiss a waitlist signup from the Discord admin channel's " +
      "button — minting the signup invite + welcome email exactly like the web " +
      "Approve. Can ONLY approve / dismiss an existing signup — never read tenant " +
      "data, mint tokens, or any other admin surface.",
    allow: [
      ["POST", /^\/super-admin\/waitlist\/[^/]+\/approve$/],
      ["POST", /^\/super-admin\/waitlist\/[^/]+\/dismiss$/],
    ],
  },
  {
    key: "drive:control",
    label: "Browser driving (Claude / MCP)",
    description:
      "Drive the user's own open Cobblr tab — open the driver stream, request a " +
      "window, and navigate it. Gated further by the user's per-workspace drive " +
      "grant (off by default). Never reads or writes workspace data.",
    allow: [
      ["GET", /^\/orgs\/[^/]+\/drive\/driver\/stream$/],
      ["POST", /^\/orgs\/[^/]+\/drive\/driver\/request$/],
      ["POST", /^\/orgs\/[^/]+\/drive\/driver\/navigate$/],
      ["POST", /^\/orgs\/[^/]+\/drive\/driver\/present$/],
      ["GET", /^\/orgs\/[^/]+\/drive\/driver\/observe$/],
      ["GET", /^\/orgs\/[^/]+\/drive\/status$/],
    ],
  },
  {
    key: "announce:post",
    label: "Post announcements & notices",
    description:
      "Post bundle / feature updates to the public announcement channels, and send targeted breaking-change notices to affected workspace members. Read-only on the settings; can't reconfigure channels.",
    allow: [
      ["GET", /^\/super-admin\/announce-settings$/],
      ["POST", /^\/super-admin\/announce$/],
      // Targeted "advise affected users of a breaking change" notices.
      ["POST", /^\/super-admin\/notices$/],
    ],
  },
];

const BY_KEY = new Map(TOKEN_SCOPES.map((s) => [s.key, s] as const));

/** Public, secret-free view for the mint UI. */
export function listScopeChoices(): Array<{ key: string; label: string; description: string }> {
  return TOKEN_SCOPES.map(({ key, label, description }) => ({ key, label, description }));
}

/** Keep only keys we actually know about (drop typos / removed scopes). */
export function sanitizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.filter((s) => BY_KEY.has(s)))];
}

/** /api/v1-relative path: no query, no trailing slash, prefix stripped. */
function relPath(originalUrl: string): string {
  const path = (originalUrl.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
  return path.replace(/^\/api\/v1/, "") || "/";
}

/**
 * For a SCOPED token: does ANY of its scopes allow this request?
 * Deny-by-default — unknown scope keys contribute nothing, and a token with
 * scopes that match no rule is denied. Never call this for an UNSCOPED token
 * (null/empty scopes) — those are unrestricted and skip the clamp entirely.
 */
export function tokenScopeAllows(scopes: string[], method: string, originalUrl: string): boolean {
  const rel = relPath(originalUrl);
  if (rel.includes("..")) return false;
  for (const key of scopes) {
    const def = BY_KEY.get(key);
    if (!def) continue;
    for (const [m, re] of def.allow) {
      if (m === method && re.test(rel)) return true;
    }
  }
  return false;
}
