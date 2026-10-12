// Who or what an activity row is about, named the way a person knows it
// (#5906). One namer for every door the log is read through: a workspace's
// feed and a record's History (GET /activity), "Your activity" across every
// workspace (GET /me/activity), and Cobb's list_activity, which reads the
// first. Each row's subject is its live record (title, the collection it is
// filed in, a link to open it), the record a row declares it is about
// (`diff.subject`), one a row written before it declared one can still be
// traced to (a reservation's part, a link's record), or a platform thing by
// its human name (a module by its display name). A row it cannot name falls
// back to activityPresentation's words for the kind, never the stored type.

import type { Kysely } from "kysely";
import type { ActivitySubject } from "@cobblr/platform-contract/activity-summary";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { meta } from "../db/meta.js";
import { getEntry as getModuleEntry } from "../modules/registry.js";
import type { TenantDB } from "../db/tenant-schema.js";
import { activityFileContexts } from "./activity-context.js";
import type { ActivityEntry } from "./activity.js";
import { lookupMany } from "./entities.js";
import { historyBag } from "./record-history.js";
import { applyServedTitle } from "./served-title.js";
import { collectionKindOf } from "@cobblr/platform-contract/record-subjects";

// The kind a record is filed under is the shared record namer's, so the feed
// and every other surface that names a record agree.
export { collectionKindOf } from "@cobblr/platform-contract/record-subjects";

export interface ActivityRowRef {
  id: number;
  action: string;
  module_name: string | null;
  entity_type: string;
  entity_id: string;
  diff: unknown;
}

export interface NamedActivity {
  /** The record's live title, when the row's own diff names nothing. */
  title: string | null;
  /** The collection the record is filed in (`books:item`), else its module kind. */
  kind: string | null;
  /** What the row is about, linked: handed to activityPresentation. */
  subject?: ActivitySubject;
  /** What a file row's context adds to its diff (the scan or the record). */
  contextDiff?: Record<string, unknown>;
}

type Ref = { kind: string; id: string };
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The record a row is about, when it is not the row's own entity: what it
 *  declared (`diff.subject`), else what a row of its type carries. */
async function subjectRefs(orgId: string, items: readonly ActivityRowRef[]): Promise<Map<number, Ref>> {
  const out = new Map<number, Ref>();
  const pairingIds: string[] = [];
  for (const i of items) {
    const d = historyBag(i.diff);
    const declared = historyBag(d.subject);
    if (str(declared.kind) && str(declared.id)) out.set(i.id, { kind: declared.kind as string, id: declared.id as string });
    // A reservation is of a part: its row names the part's id.
    else if (i.entity_type === "allocation" && str(d.part_id)) out.set(i.id, { kind: "inventory:part", id: d.part_id as string });
    else if (i.entity_type === "pairing") pairingIds.push(i.entity_id);
  }
  // A link is between two records: an older row names neither, so read the
  // link itself (a deleted one names nothing, and falls back to its words).
  if (pairingIds.length) {
    const rows = await meta
      .selectFrom("entity_pairings")
      .select(["id", "source_kind", "source_id"])
      .where("org_id", "=", orgId)
      .where("id", "in", [...new Set(pairingIds)])
      .execute();
    const byId = new Map(rows.map((r) => [String(r.id), { kind: r.source_kind, id: r.source_id }]));
    for (const i of items) if (i.entity_type === "pairing" && !out.has(i.id) && byId.has(i.entity_id)) out.set(i.id, byId.get(i.entity_id)!);
  }
  return out;
}

/** Every row's subject, named and linked, for one workspace. */
export async function nameActivityRows(
  org: { id: string; slug: string; name: string },
  db: Kysely<TenantDB>,
  viewer: { userId: string; role: string },
  items: readonly ActivityRowRef[],
): Promise<Map<number, NamedActivity>> {
  const named = new Map<number, NamedActivity>();
  if (!items.length) return named;
  const slug = encodeURIComponent(org.slug);
  // Module-owned records whose diff carries no name get their live title
  // ("updated · RailCore 300ZL", not the bare "machine"); every module-owned
  // record gets its collection (a part shelved as a book is a book). One
  // record, several rows: it needs a title if ANY row lacks one (#3994).
  const toResolve = new Map<string, { kind: string; entityId: string; needsTitle: boolean }>();
  for (const i of items) {
    if (!i.module_name || !i.entity_id) continue;
    const d = historyBag(i.diff);
    const titled = typeof d.name === "string" || typeof d.title === "string" || typeof d.label === "string";
    const key = `${i.entity_type}:${i.entity_id}`;
    toResolve.set(key, { kind: `${i.module_name}:${i.entity_type}`, entityId: i.entity_id, needsTitle: (toResolve.get(key)?.needsTitle ?? false) || !titled });
  }
  const contexts = await activityFileContexts(db, items as unknown as ActivityEntry[]);
  const about = await subjectRefs(org.id, items);
  const refs: Ref[] = [...toResolve.values()].map((r) => ({ kind: r.kind, id: r.entityId }));
  for (const r of about.values()) refs.push(r);
  for (const context of contexts.values()) {
    const ref = context.record ?? (context.scan?.kind && context.scan.recordId ? { kind: context.scan.kind, id: context.scan.recordId } : null);
    if (ref) refs.push(ref);
  }
  const resolved = (await lookupMany(org.id, refs, { userId: viewer.userId, role: viewer.role })).map(applyServedTitle);
  const recordByRef = new Map(resolved.map((r) => [`${r.kind}:${r.id}`, r]));
  for (const ref of refs) {
    if (recordByRef.has(`${ref.kind}:${ref.id}`)) continue;
    const record = resolved.find((r) => r.id === ref.id && collectionKindOf(r, r.kind) === ref.kind);
    if (record) recordByRef.set(`${ref.kind}:${ref.id}`, record);
  }

  for (const i of items) {
    const base = i.module_name ? `${i.module_name}:${i.entity_type}` : null;
    const r = base ? recordByRef.get(`${base}:${i.entity_id}`) : undefined;
    const key = `${i.entity_type}:${i.entity_id}`;
    const out: NamedActivity = { title: null, kind: null };
    if (r) {
      if (toResolve.get(key)?.needsTitle && r.title) out.title = r.title;
      out.kind = collectionKindOf(r, base!);
    }
    const context = contexts.get(`${i.action}:${i.entity_id}`);
    const ref = about.get(i.id) ?? context?.record ?? (context?.scan?.kind && context.scan.recordId ? { kind: context.scan.kind, id: context.scan.recordId } : null);
    const target = ref ? recordByRef.get(`${ref.kind}:${ref.id}`) : r;
    const targetKind = target ? collectionKindOf(target, target.kind) : context?.scan ? null : base;
    const thumbnail = context?.photoId
      ? `/api/v1/orgs/${slug}/modules/core-files/files/${context.photoId}/raw?variant=thumb`
      : target?.image_path?.startsWith("/files/") ? `/api/v1/orgs/${slug}/modules/core-files${target.image_path}` : target?.image_path ?? null;
    const href = target && targetKind ? `/w/${slug}${target.detailUrl ?? openRecordPath(targetKind, target.id)}`
      : context?.scan ? `/w/${slug}/scan?item=${encodeURIComponent(context.scan.id)}` : null;
    if (href) out.subject = { href, title: target?.title ?? context?.scan?.name ?? context?.scan?.barcode ?? "a photo", kind: targetKind, id: target?.id ?? context?.scan?.id ?? i.entity_id, thumbnail };
    else if (r && base) out.subject = { href: `/w/${slug}${r.detailUrl ?? openRecordPath(base, r.id)}`, title: r.title, kind: base, id: r.id, thumbnail };
    // A record the row is about names the row too ("reserved Review Blue Owl").
    if (!out.title && about.has(i.id) && target?.title) out.title = target.title;
    // Platform things, by the name a person knows: a module by its display
    // name, an account joining by the workspace it joined.
    if (i.entity_type === "org_module") {
      const name = getModuleEntry(i.entity_id)?.manifest.displayName || null;
      if (name) {
        out.title = name;
        out.subject = { href: `/w/${slug}/configuration/modules`, title: name, kind: null, id: i.entity_id, thumbnail: null };
      }
    } else if (i.entity_type === "user" || i.action === "member_joined") out.title = org.name;
    if (context?.scan) out.contextDiff = { scan: { ...context.scan, name: target?.title ?? context.scan.name } };
    else if (context?.record && target) out.contextDiff = { record: { ...context.record, name: target.title } };
    named.set(i.id, out);
  }
  return named;
}
