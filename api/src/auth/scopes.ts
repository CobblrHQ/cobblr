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
    key: "feedback:triage",
    label: "Feedback triage",
    description:
      "Read the platform feedback queue and resolve / notify reporters. Nothing else.",
    allow: [
      ["GET", /^\/super-admin\/feedback(\/.*)?$/],
      ["PATCH", /^\/super-admin\/feedback\/[^/]+$/],
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
    key: "announce:post",
    label: "Post announcements",
    description:
      "Post bundle / feature updates to the announcement channels. Read-only on the settings; can't reconfigure channels.",
    allow: [
      ["GET", /^\/super-admin\/announce-settings$/],
      ["POST", /^\/super-admin\/announce$/],
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
