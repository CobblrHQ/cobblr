/** The deep path to preserve across a workspace redirect: the request path with
 *  any leading `/w/<slug>` stripped, so it can be re-prefixed with the resolved
 *  workspace. Bare paths (no `/w/…`) pass through unchanged.
 *
 *  Shared by BOTH redirect sites — the bare-URL landing (App.tsx LandingRedirect)
 *  and the unknown-slug bounce (ActiveOrgContext) — so a deep link can never be
 *  silently dropped by only one of them. That divergence is exactly the bug this
 *  fixes: a `/w/<placeholder>/configuration/api-recipes` docs link used to bounce
 *  to the workspace ROOT, losing the page; a bare link already worked. */
export function deepPathAfterWorkspace(pathname: string): string {
  return pathname.replace(/^\/w\/[^/]+/, "") || "/";
}

/** A uuid path segment: a RECORD, and records do not exist in another
 *  workspace. Ids elsewhere in Cobblr are uuids (parts, orders, assets), so
 *  this deliberately does not try to guess at numeric segments, which are as
 *  often a page as an id. */
const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where the SAME place lives in a different workspace.
 *
 * Switching workspaces used to land on the dashboard whatever you were looking
 * at, so going from one workspace's scan page to another's meant navigating
 * back by hand every time.
 *
 * The path can only be carried over as far as it stays workspace-independent:
 *
 *   /scan                    -> /scan                 a section exists in both
 *   /configuration/units     -> /configuration/units   structural, not a record
 *   /inventory/parts/<uuid>  -> /inventory             that record is not there
 *
 * The last case truncates to the SECTION rather than to `/inventory/parts`,
 * because the segment before an id belongs to a detail route (`parts/:id`) and
 * is not a page on its own: keeping it would land on nothing.
 *
 * Anything that survives this and still does not exist in the target (a module
 * that workspace has not enabled, an instance it does not have) hits the
 * in-workspace catch-all and redirects to the dashboard, which is exactly
 * today's behaviour. So this can only ever do better, never worse.
 */
export function pathAcrossWorkspaces(pathname: string): string {
  const deep = deepPathAfterWorkspace(pathname);
  const segs = deep.split("/").filter(Boolean);
  const idAt = segs.findIndex((s) => RECORD_ID.test(s));
  if (idAt === -1) return segs.length ? `/${segs.join("/")}` : "/";
  // A path that is nothing but a record has no section to fall back to.
  return idAt === 0 ? "/" : `/${segs[0]}`;
}

/**
 * A stored notification link, as something the ROUTER can actually use.
 *
 * The router's basename is already `/w/<handle>`, so a link carrying its own
 * `/w/<slug>` resolves to `/w/current/w/other/scan`, matches nothing, and the
 * catch-all lands you on the dashboard. That is the "I clicked a notification
 * and it took me to the dashboard" report, and it is why stripping the ORIGIN
 * alone was not enough: an absolute link and a workspace-prefixed one fail the
 * same way, and only one of them looks wrong.
 *
 * `lint:notification-links` stops new rows storing an absolute URL, but
 * notification rows are IMMUTABLE: only read_at and delivered_via are ever
 * updated. Links written before that lint existed cannot be migrated, so
 * handling this at READ time is the only fix that reaches them. Measured on
 * prod 2026-08-14: 8 of 51 recent rows carry a workspace prefix.
 *
 * A link to another origin is not a route at all and comes back as `external`
 * for the caller to open in a tab.
 */
export function notificationRoute(
  link: string | null | undefined,
  origin: string = typeof window === "undefined" ? "" : window.location.origin,
): { path?: string; external?: string } {
  const raw = (link ?? "").trim();
  if (!raw) return {};
  let rest = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.origin !== origin) return { external: raw };
      rest = `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return {};
    }
  }
  if (!rest.startsWith("/")) rest = `/${rest}`;
  // The workspace prefix is the router's job, not the link's. Whichever
  // workspace the click resolves to re-adds it.
  return { path: deepPathAfterWorkspace(rest) };
}
