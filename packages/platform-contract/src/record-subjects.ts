// A record a surface mentions, named the way a person knows it: its live
// title, linked to where it opens, the collection it is filed in. One namer
// for the activity feed (#5906) and for anything else that stores a record's
// id and shows it later, such as a build's as-built history (#5977), which
// printed the first eight characters of an id. A record this cannot name
// (gone, or one the reader may not see) has no entry: the caller says it in
// words, never with the id.

import type { EntityViewer } from "@cobblr/platform-contract";
import { platform } from "@cobblr/platform-contract/platform-runtime";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import type { ActivitySubject } from "@cobblr/platform-contract/activity-summary";

/** The kind a resolved record is FILED under: `<instance>:item` for a record
 *  in a named instance (read off its instance field, else its detail route,
 *  the same seam the scan matcher's toMatch reads), the module kind
 *  otherwise. */
export function collectionKindOf(r: { fields?: Record<string, unknown>; detailUrl?: string | null }, moduleKind: string): string {
  const inst = r.fields?.instance;
  const moduleName = moduleKind.split(":")[0];
  if (typeof inst === "string" && inst && inst !== moduleName) return `${inst}:item`;
  const m = /^\/instances\/([^/]+)\//.exec(r.detailUrl ?? "");
  return m?.[1] ? `${m[1]}:item` : moduleKind;
}

/** Each ref that resolves, keyed `kind:id` as asked, named and linked for the
 *  workspace `slug`. */
export async function nameRecords(
  orgId: string,
  slug: string,
  refs: ReadonlyArray<{ kind: string; id: string }>,
  viewer?: EntityViewer,
): Promise<Map<string, ActivitySubject>> {
  const out = new Map<string, ActivitySubject>();
  const wanted = [...new Map(refs.map((r) => [`${r.kind}:${r.id}`, r])).values()];
  if (!wanted.length) return out;
  const resolved = await platform().entities.lookupMany(orgId, wanted, viewer);
  const ws = `/w/${encodeURIComponent(slug)}`;
  for (const ref of wanted) {
    const r = resolved.find((x) => x.id === ref.id);
    if (!r) continue;
    const kind = collectionKindOf(r, r.kind);
    out.set(`${ref.kind}:${ref.id}`, {
      href: `${ws}${r.detailUrl ?? openRecordPath(kind, r.id)}`,
      title: r.title,
      kind,
      id: r.id,
      thumbnail: r.image_path?.startsWith("/files/") ? `/api/v1/orgs/${encodeURIComponent(slug)}/modules/core-files${r.image_path}` : r.image_path ?? null,
    });
  }
  return out;
}
