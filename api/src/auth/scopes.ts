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
    key: "ops:read",
    label: "Operator read-only",
    description:
      "Read the operator dashboards - overview counts and product metrics. No tenant " +
      "data, no writes, nothing else. For a cross-instance ops console that reports on " +
      "several deployments at once.",
    // GET only, and only the two aggregate surfaces. Deliberately NOT /workspaces,
    // /users or /activity: a token that leaves one deployment to be read by another
    // process should carry as little of other people's data as the job allows, and the
    // job is counts and trends.
    allow: [
      ["GET", /^\/super-admin\/overview$/],
      ["GET", /^\/super-admin\/product-metrics$/],
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
  {
    key: "instances:rehome",
    label: "Re-home a collection onto Records",
    description:
      "Move ONE named collection from the assets module onto the Records substrate " +
      "(ids preserved, attachments + tags follow, borrowed field values fold into the " +
      "record). ONLY that operation — cannot read tenant data, mint tokens, or touch " +
      "any other admin surface. The operation is itself idempotent and rolls back whole.",
    allow: [["POST", /^\/super-admin\/rehome-instance$/]],
  },
];

const BY_KEY = new Map(TOKEN_SCOPES.map((s) => [s.key, s] as const));

// ── Parameterized record-data scopes ─────────────────────────────────────────
// A `records:<target>:<action>` scope is generated on the fly — there's one per
// workspace record kind, so unlike the static defs above we can't enumerate
// them. `<target>` names a kind the way the entity-kind registry routes it:
//   - `<instance>`            → an instance kind at /instances/<instance>/items
//   - `<module>/<collection>` → a module kind at /modules/<module>/<collection>
//   - `*`                     → any record, either family
// `<action>` is read | create | write | delete (write ⊇ create + update). The
// frontend derives the target from a kind's own module_name + endpoints (the
// same registry it lists), so scope and snippet always address the same route.
// Deny-by-default, enforced HERE server-side — the mint UI is never the boundary.
const SEG = "[a-z0-9][a-z0-9_-]{0,62}";
const RECORD_SCOPE_RE = new RegExp(`^records:(\\*|${SEG}(?:/${SEG})?):(read|create|write|delete)$`);

export function isRecordScope(key: string): boolean {
  return RECORD_SCOPE_RE.test(key);
}

/** The path base a target clamps to (no `^`/`$`; the collection route itself). */
function recordScopeBase(target: string): string {
  if (target === "*") return "/orgs/[^/]+/(?:instances/[^/]+/items|modules/[^/]+/[^/]+)";
  if (target.includes("/")) {
    const [mod, coll] = target.split("/");
    return `/orgs/[^/]+/modules/${mod}/${coll}`;
  }
  return `/orgs/[^/]+/instances/${target}/items`;
}

/** Does one records:<target>:<action> scope permit this method + path? */
function recordScopeAllows(key: string, method: string, rel: string): boolean {
  const m = RECORD_SCOPE_RE.exec(key);
  if (!m) return false;
  const base = recordScopeBase(m[1]!); // RE already limits target to safe segments
  const action = m[2];
  const collection = new RegExp(`^${base}$`);
  const item = new RegExp(`^${base}/[^/]+$`);
  const allow: Array<[string, RegExp]> =
    action === "read"
      ? [["GET", collection], ["GET", item]]
      : action === "create"
        ? [["POST", collection]]
        : action === "write"
          ? [["POST", collection], ["PATCH", item]] // create + update
          : [["DELETE", item]]; // delete
  return allow.some(([mm, re]) => mm === method && re.test(rel));
}

/** Public, secret-free view for the mint UI. */
export function listScopeChoices(): Array<{ key: string; label: string; description: string }> {
  return TOKEN_SCOPES.map(({ key, label, description }) => ({ key, label, description }));
}

/** Keep only keys we actually know about (drop typos / removed scopes). Static
 *  keys must be in BY_KEY; record scopes must match the parameterized grammar. */
export function sanitizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.filter((s) => BY_KEY.has(s) || isRecordScope(s)))];
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
    if (isRecordScope(key)) {
      if (recordScopeAllows(key, method, rel)) return true;
      continue;
    }
    const def = BY_KEY.get(key);
    if (!def) continue;
    for (const [m, re] of def.allow) {
      if (m === method && re.test(rel)) return true;
    }
  }
  return false;
}
