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

/** Every stored-file path inside a value (a row, its metadata), re-spelled for
 *  the workspace it now lives in and the id its file came back under. A
 *  restored backup kept its pictures' old addresses and served none of them
 *  (#4217). External URLs are left as they are. */
export function repathFiles<T>(value: T, slug: string, newIds?: ReadonlyMap<string, string>): T {
  if (typeof value === "string") {
    const old = fileIdFromRawPath(value);
    // The file came back under a new id; a path carries the id inside it, so
    // a whole-value id swap never reaches it.
    const id = old ? (newIds?.get(old) ?? old) : null;
    // RAW_PATH matches from /orgs/…, so whatever came before it (an /api/v1
    // prefix, an origin) is kept as it was.
    return (id ? value.replace(RAW_PATH, `/orgs/${slug}/modules/core-files/files/${id}/raw`) : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => repathFiles(v, slug, newIds)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, repathFiles(v, slug, newIds)])) as T;
  }
  return value;
}
