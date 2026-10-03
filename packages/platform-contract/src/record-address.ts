/** A record's browser address, qualified by the workspace that owns it.
 *  `origin` may be empty when only an app path is available; either way the
 *  address starts at `/w/<workspace>` rather than relying on a reader's
 *  default workspace. */
export function recordAddress(origin: string | null | undefined, workspaceSlug: string, detailPath: string): string {
  const base = (origin ?? "").trim().replace(/\/+$/, "");
  const detail = `/${detailPath.replace(/^\/+/, "")}`;
  return `${base}/w/${encodeURIComponent(workspaceSlug)}${detail}`;
}
