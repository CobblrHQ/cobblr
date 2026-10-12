// Is this record one the wire is about (#6070)?
//
// A wire's filter may name the records it is about (`filter.in`,
// wire-narrowing.ts): one record, a category, a tag or a saved view. This
// answers it for the record the event is about (the SOURCE record), before
// the wire's conditions are read. A record that cannot be judged (a view
// that is gone or private, a tag lookup that failed) is not in: a narrowed
// wire that cannot tell stays quiet rather than firing for everything.

import { platform, viewQuery } from "@cobblr/platform-contract";
import { readSavedView } from "@cobblr/platform-contract/saved-view-reader";
import type { WireRecords } from "@cobblr/platform-contract/wire-narrowing";

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Whether a saved view's query takes in this record. The view's own query
 *  with the record's id added, so the answer is the view's, never a guess. */
async function inView(orgId: string, viewId: string, sourceId: string): Promise<boolean> {
  const view = await readSavedView(orgId, viewId);
  if (!view) return false;
  const query = viewQuery(view.config, await platform().accounts.dayFor(null));
  const kind = view.entityKind;
  const probe = await platform().entities.list(orgId, kind, { ...query, filter: { ...(query.filter ?? {}), id: sourceId }, limit: 5 });
  if (probe.items.some((r) => r.id === sourceId)) return true;
  // A resolver that does not read `id` from a filter answered the view's
  // first page instead: read the whole view.
  if (!probe.items.length) return false;
  const all = await platform().entities.listAll(orgId, kind, query);
  return all.items.some((r) => r.id === sourceId);
}

export async function inWireRecords(
  orgId: string,
  records: WireRecords,
  source: { kind: string; id: string; fields: Record<string, unknown> },
): Promise<boolean> {
  if (!source.id) return false;
  if (records.record) return source.id === records.record;
  if (records.category) return norm(source.fields.category_name ?? source.fields.category) === norm(records.category);
  if (records.tag) {
    const tags = await platform().tags.of({ orgId, target: { kind: source.kind, id: source.id } });
    return tags.some((t) => norm(t) === norm(records.tag));
  }
  if (records.view) return inView(orgId, records.view, source.id);
  return true;
}
