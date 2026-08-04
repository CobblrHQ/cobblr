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
