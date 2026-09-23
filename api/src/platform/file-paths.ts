// The one spelling of a stored file's served path, both ways.
//
// A record points at its picture by path (`image_path`), and the path names the
// workspace it lives in. Anything that moves a record between workspaces has to
// read the file id back out of the old path and write the new workspace's path,
// and graduation and the trial carry both do. Two copies of this rule would
// drift the way every copied rule in #3421 did, and a drifted copy here reads a
// real photo as an external link and carries a URL into a workspace that
// cannot open it.

const RAW_PATH = /\/orgs\/[^/]+\/modules\/core-files\/files\/([^/?]+)\/raw/;

/** The stored file a served path points at, or null for anything else (an
 *  external catalog URL, which is portable and travels as it is). */
export function fileIdFromRawPath(path: unknown): string | null {
  if (typeof path !== "string" || !path) return null;
  return path.match(RAW_PATH)?.[1] ?? null;
}

/** The path a workspace serves one of its stored files at. */
export function rawPathFor(slug: string, fileId: string): string {
  return `/api/v1/orgs/${slug}/modules/core-files/files/${fileId}/raw`;
}
