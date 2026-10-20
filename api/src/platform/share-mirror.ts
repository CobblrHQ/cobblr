import { shareChildrenFor } from "./share-children.js";
import { isOwnLink } from "./share-sync.js";
// The mirror: what the owner shares, copied into the share space, kept in step
// (#4627 §2, docs/design-decisions/share-spaces.md §7).
//
// The owner's side decides everything. A pass (mirrorShare) reads the share's
// scope and visibility (@cobblr/platform-contract/share-scope), works out each
// record as the friend may see it, and compares it with what it last sent
// (share_mirror_state): only what changed goes, over the link's ordered,
// signed outbox. First the collections' shape (a blueprint subset: their
// modules, instances, bundles and fields, without the fields the friend may
// not see), then each record, then the removal of each record that left the
// scope. A toggle turned off changes what each record projects to, so every
// copy is rewritten without it.
//
// The share's side applies what arrives: the shape through the blueprint
// installer, each record into a copy keyed by `origin_ref` (the share's link,
// the original's kind and id), a removal by deleting the copy. A copy never
// carries more than the owner's side sent, and a reference to something out
// of scope is never sent at all.

import { createHash } from "node:crypto";
import { sql } from "kysely";
import { DuplicateRecordError, placeLine, platform, type EntityWriter } from "@cobblr/platform-contract";
import { classifyField, projectRecord, readScope, readVisibility, type ClassifiableField, type ScopeRef, type VisibilityDef } from "@cobblr/platform-contract/share-scope";
import { meta } from "../db/meta.js";
import { applyBlueprint, BlueprintManifest, captureBlueprint } from "../routes/blueprint.js";
import { baseKindOf, kindRecordForOrg, lookup } from "./entities.js";
import { fileIdFromRawPath, rawPathFor } from "./file-paths.js";
import { privateFieldNames } from "./field-defs.js";
import { gatedFields, recordsInScope } from "./scope-eval.js";
import { sharePerson } from "./share-person.js";
import { enqueueShareOp, flushShareLinkNow, kickShareSync, registerShareOp, type ShareLinkRow } from "./share-sync.js";
import { withShareCopyState } from "./share-copy-state.js";
import { runExclusive } from "./exclusive.js";
import { editsMadeDuringApply, type Bags } from "./share-held-edits.js";
import { writerFor } from "./kind-writer.js";
import { perKeyCoalesced } from "../lib/per-key-coalesce.js";

/** The metadata key a copy carries: which share and which original it is. */
export const ORIGIN_REF_KEY = "origin_ref";
const SHAPE_KEY = "shape:all";
/** Part of every record's digest: raising it resends every record once, on
 *  each share's next pass (the daily reconcile at the latest). 2: a copy is
 *  cleared of what is no longer sent, so copies left holding a revoked field
 *  before that fix are cleared too (#4688). */
const MIRROR_FORMAT = 2;
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/** Every field of a kind, with what it is: its own columns and the custom
 *  fields, and which of them the owner marked private. */
export async function fieldsOf(orgId: string, kind: string): Promise<ClassifiableField[]> {
  const rec = await kindRecordForOrg(orgId, kind);
  const priv = await privateFieldNames(orgId, kind);
  const native: ClassifiableField[] = (rec?.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    field_role: f.fieldRole ?? null,
    money: (f as { money?: "cents" | "amount" | null }).money ?? null,
    private: priv.has(f.name),
    read_only: (f as { readOnly?: boolean }).readOnly === true,
  }));
  const custom = (await platform().entities.fieldsFor(orgId, kind)).map((d) => ({
    name: d.name,
    type: d.type,
    field_role: d.field_role ?? null,
    unit: d.unit ?? null,
    private: d.private === true || priv.has(d.name),
  }));
  return [...native, ...custom];
}

/** A reference to another record: never mirrored (it may be out of scope,
 *  and its id means nothing on the other side). */
export const isReference = (name: string, f?: ClassifiableField) => /_id$/.test(name) || f?.type === "relation" || f?.type === "person";

/** A location and its parents, innermost first, by following parent_id. */
async function locationChain(orgId: string, locationId: unknown): Promise<Array<{ name: string }>> {
  const out: Array<{ name: string }> = [];
  let id = typeof locationId === "string" ? locationId : null;
  for (let i = 0; id && i < 12; i++) {
    const loc = await lookup(orgId, "core-locations:location", id).catch(() => null);
    if (!loc) break;
    out.push({ name: loc.title });
    const parent = (loc.fields as Record<string, unknown>)?.parent_id;
    id = typeof parent === "string" ? parent : null;
  }
  return out;
}

export interface Projected {
  title: string;
  fields: Record<string, unknown>;
  metadata: Record<string, unknown>;
  place: { text: string | null; path: string[] | null };
  photo: { fileId: string } | null;
}

export async function project(orgId: string, ref: ScopeRef, vis: VisibilityDef, gated: ReadonlySet<string>): Promise<Projected | null> {
  const ent = await lookup(orgId, ref.entity_kind, ref.id);
  if (!ent) return null;
  const defs = await fieldsOf(orgId, ref.entity_kind);
  const byName = new Map(defs.map((d) => [d.name, d]));
  const p = projectRecord({ fields: (ent.fields ?? {}) as Record<string, unknown> }, defs, gated, vis);
  const drop = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !isReference(k, byName.get(k)) && k !== "image_path" && k !== ORIGIN_REF_KEY));
  let steps = ((await platform().placement.pathsOf({ orgId, containees: [{ kind: ref.entity_kind, id: ref.id }] }).catch(() => new Map())).get(ref.id) ?? []) as Array<{ name: string }>;
  // A record that keeps its place on its own row (a location_id written by a
  // module that does not place through the seam) is placed all the same.
  if (!steps.length) steps = await locationChain(orgId, (ent.fields as Record<string, unknown>)?.location_id);
  const said = (ent.fields as Record<string, unknown>)?.location_name;
  if (!steps.length && typeof said === "string" && said.trim()) steps = [{ name: said.trim() }];
  const names = steps.map((s) => s.name);
  const photoId = fileIdFromRawPath((ent.fields as Record<string, unknown>)?.image_path);
  return {
    title: ent.title,
    fields: drop(p.fields),
    metadata: drop(p.metadata),
    place: names.length ? (vis.places ? { text: null, path: [...names].reverse() } : { text: placeLine(steps), path: null }) : { text: null, path: null },
    photo: photoId ? { fileId: photoId } : null,
  };
}

/** The collections' shape, as a blueprint the share space installs: their
 *  modules, instances and bundles, and the fields the friend may see. */
async function shapeFor(orgId: string, kinds: string[], vis: VisibilityDef, gated: ReadonlySet<string>): Promise<Record<string, unknown>> {
  const full = await captureBlueprint(orgId);
  const instanceNames = new Set(kinds.filter((k) => k.endsWith(":item")).map((k) => k.slice(0, -":item".length)));
  const modules = new Set<string>();
  for (const k of kinds) modules.add((await baseKindOf(orgId, k)).split(":")[0]!);
  // registry-filter-ok: only the shared collections' instances travel, by design
  const instances = full.instances.filter((i) => instanceNames.has(i.instance_name));
  for (const i of instances) modules.add(i.module);
  // registry-filter-ok: only the bundles that provide a shared collection travel
  const bundles = full.bundles.flatMap((b) => {
    const shared = sharedPartOfBundle(b as BundleShape, instanceNames);
    return shared ? [shared] : [];
  });
  const fieldDefs = [];
  for (const f of full.field_defs.filter((d) => kinds.includes(d.entity_kind))) {
    const priv = (await privateFieldNames(orgId, f.entity_kind)).has(f.name);
    const cls = classifyField({ name: f.name, type: f.type, private: priv }, gated);
    if (cls === "plain" || (cls === "price" && vis.prices) || (cls === "private" && vis.private_notes) || (cls === "place" && vis.places) || (cls === "restricted" && vis.restricted.includes(f.name))) fieldDefs.push(f);
  }
  return {
    kind: "cobblr.blueprint",
    id: "cobblr.share-shape",
    version: "1",
    name: "Shared collections",
    modules: [...modules].map((name) => ({ name })),
    instances,
    bundles,
    wires: [],
    field_defs: fieldDefs,
    saved_views: [],
    public_surfaces: [],
  };
}

type InstanceDecl = { instance_name?: string; name?: string };
type BundleShape = { provides_instances?: InstanceDecl[]; features?: Array<{ key?: string; default?: boolean; provides_instances?: InstanceDecl[] }> } & Record<string, unknown>;

/** The part of a bundle a share space needs: only the collections shared
 *  with it, and the features that provide them turned on. A Pattern table
 *  comes from Yarn's "designs" feature, off by default: the whole bundle sent
 *  as it is gave the friend a Patterns list with no pattern fields, no file
 *  intake and no pattern panels (#6056), and sent with every feature on it
 *  would hand them the owner's Yarn stash table too. Null when the bundle
 *  provides none of the shared collections. */
export function sharedPartOfBundle(b: BundleShape, instanceNames: ReadonlySet<string>): BundleShape | null {
  const nameOf = (i: InstanceDecl) => i.instance_name ?? i.name ?? "";
  const top = (b.provides_instances ?? []).filter((i) => instanceNames.has(nameOf(i)));
  const features = (b.features ?? [])
    .filter((f) => (f.provides_instances ?? []).some((i) => instanceNames.has(nameOf(i))))
    .map((f) => ({ ...f, default: true, provides_instances: (f.provides_instances ?? []).filter((i) => instanceNames.has(nameOf(i))) }));
  if (!top.length && !features.length) return null;
  return { ...b, provides_instances: top, features };
}

/** The kind each record travels as. A record in a named instance (a
 *  Pattern: a project in Yarn's "designs") travels as that instance's kind,
 *  "designs:item", so the share space gets the instance, its fields and its
 *  page, not a plain project (#6056). */
async function carriedRefs(orgId: string, refs: ScopeRef[]): Promise<ScopeRef[]> {
  const named = new Set(
    (await meta.selectFrom("workspace_module_instances").select("instance_name").where("org_id", "=", orgId).where("is_default", "=", false).execute()).map((r) => r.instance_name),
  );
  const out = new Map<string, ScopeRef>();
  for (const r of refs) {
    let kind = r.entity_kind;
    if (named.size && !kind.endsWith(":item")) {
      const inst = ((await lookup(orgId, kind, r.id).catch(() => null))?.fields as Record<string, unknown> | undefined)?.instance;
      if (typeof inst === "string" && named.has(inst)) kind = `${inst}:item`;
    }
    out.set(`${kind}\u0000${r.id}`, { ...r, entity_kind: kind });
  }
  return [...out.values()];
}

/** What the owner wrote about a record in rows of its own (a pattern's
 *  needs), by set, as each module gives them to travel (#6252). Inside the
 *  record's digest, so a change to a need is a change to the record. */
async function childRowsOf(orgId: string, kind: string, id: string): Promise<Record<string, Array<Record<string, unknown>>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const def of shareChildrenFor(await baseKindOf(orgId, kind))) out[def.name] = await def.read(orgId, id);
  return out;
}

/** Largest attached file a share carries; a bigger one is left out and said. */
const FILE_CAP_BYTES = 25 * 1024 * 1024;

/** What is attached to a record: a Pattern's PDF, a manual, its photos. They
 *  travel with it, each once (by the owner's file id), so the friend reads
 *  the pattern the owner shared (#6056). */
async function attachedFiles(orgId: string, kind: string, id: string) {
  const [module, type] = (await baseKindOf(orgId, kind)).split(":", 2);
  if (!module || !type) return [];
  const rows = (await platform().files.listAttachments(orgId, { source_module: module, source_type: type, source_id: id }).catch(() => null)) ?? [];
  return rows.map((a) => ({ key: a.fileId, role: a.role, filename: a.filename, mime: a.mimeType, sort_order: a.sort_order }));
}

/** One pass of a share's mirror, from the owner's side. Sends only what
 *  changed since the last pass, and removes what left the scope. */
export async function mirrorShare(linkId: string): Promise<{ sent: number; removed: number }> {
  const link = await meta.selectFrom("share_links").select(["id", "org_id", "side", "status", "settings"]).where("id", "=", linkId).executeTakeFirst();
  if (!link || isOwnLink(link) || link.side !== "owner" || link.status !== "active") return { sent: 0, removed: 0 };
  // Due no longer, BEFORE anything is read: a change the owner makes while
  // this pass runs marks the share due again (noteWorkspaceChanged only marks
  // one that is not due) and gets a pass of its own. Cleared at the end, it
  // was swallowed: that edit never reached the friend until the next one, or
  // the daily reconcile (#5119). A pass that fails marks it due again.
  await meta.updateTable("share_links").set({ mirror_due_at: null }).where("id", "=", linkId).execute();
  try {
    return await mirrorPass(link);
  } catch (err) {
    await meta.updateTable("share_links").set({ mirror_due_at: new Date() }).where("id", "=", linkId).where("mirror_due_at", "is", null).execute();
    throw err;
  }
}

async function mirrorPass(link: { id: string; org_id: string; settings: unknown }): Promise<{ sent: number; removed: number }> {
  const linkId = link.id;
  const settings = (link.settings ?? {}) as Record<string, unknown>;
  const scope = readScope(settings.scope);
  const vis = readVisibility(settings.visibility);
  const gated = new Set((await gatedFields(link.org_id)).map((f) => f.name));
  const person = await sharePerson(linkId).catch(() => null);
  const refs = await carriedRefs(link.org_id, (await recordsInScope(link.org_id, scope, { person: person?.id ?? null })).refs);
  const state = new Map<string, { entity_kind: string; entity_id: string; digest: string; photo_digest: string | null; file_keys: string[] }>(
    (await meta.selectFrom("share_mirror_state").select(["entity_kind", "entity_id", "digest", "photo_digest", "file_keys"]).where("link_id", "=", linkId).execute()).map(
      (r) => [`${r.entity_kind}\u0000${r.entity_id}`, r] as const,
    ),
  );
  // A field the friend changed and the owner has not decided on keeps the
  // friend's value in their copy: the owner's next edit elsewhere on the
  // record must not undo it under them.
  const held = new Map<string, Array<{ id: string; field: string; in_metadata: boolean; base: unknown; proposed: unknown; status: string }>>();
  for (const s of await meta
    .selectFrom("share_suggestions")
    .select(["id", "entity_kind", "entity_id", "field", "in_metadata", "base", "proposed", "status"])
    .where("link_id", "=", linkId)
    .where("status", "in", ["pending", "conflict"])
    .orderBy("created_at")
    .execute()) {
    const k = `${s.entity_kind}\u0000${s.entity_id}`;
    held.set(k, [...(held.get(k) ?? []), s]);
  }
  let sent = 0;
  let removed = 0;
  const save = (kind: string, id: string, digest: string, photo: string | null, files: string[] = []) =>
    meta
      .insertInto("share_mirror_state")
      .values({ link_id: linkId, entity_kind: kind, entity_id: id, digest, photo_digest: photo, file_keys: JSON.stringify(files) as never })
      .onConflict((oc) => oc.columns(["link_id", "entity_kind", "entity_id"]).doUpdateSet({ digest, photo_digest: photo, file_keys: JSON.stringify(files) as never, sent_at: new Date() }))
      .execute();

  const kinds = [...new Set(refs.map((r) => r.entity_kind))].sort();
  if (kinds.length) {
    const shape = await shapeFor(link.org_id, kinds, vis, gated);
    const d = sha(JSON.stringify(shape));
    if (state.get(`${SHAPE_KEY}\u0000-`)?.digest !== d) {
      await enqueueShareOp(linkId, "mirror.shape", { manifest: shape });
      await save(SHAPE_KEY, "-", d, null);
      sent++;
    }
  }
  const inScope = new Set<string>();
  for (const ref of refs) {
    const k = `${ref.entity_kind}\u0000${ref.id}`;
    inScope.add(k);
    const p = await project(link.org_id, ref, vis, gated);
    if (!p) continue;
    // The owner's value of a field both changed, so the friend's copy can
    // say "changed by <owner> since you edited".
    const changedSince: Record<string, unknown> = {};
    for (const h of held.get(k) ?? []) {
      const into = h.in_metadata ? p.metadata : p.fields;
      // The copy takes its name from the title (mirror.upsert), so a held
      // name is held in the title too.
      const titled = !h.in_metadata && h.field === "name";
      if (!(h.field in into) && !titled) continue;
      const owners = titled ? p.title : into[h.field];
      // The owner changed it after the friend did: a conflict now (#4692).
      if (h.status === "pending" && JSON.stringify(owners ?? null) !== JSON.stringify(h.base ?? null)) {
        await meta.updateTable("share_suggestions").set({ status: "conflict", owner_before: JSON.stringify(owners ?? null) as never }).where("id", "=", h.id).where("status", "=", "pending").execute();
        h.status = "conflict";
      }
      if (h.status === "conflict") changedSince[h.field] = owners;
      into[h.field] = h.proposed;
      if (titled && typeof h.proposed === "string") p.title = h.proposed;
    }
    let photo: { mime: string; data: string } | null = null;
    let photoDigest: string | null = null;
    if (p.photo) {
      const got = (await platform().files.read(link.org_id, p.photo.fileId, "medium").catch(() => null)) ?? (await platform().files.read(link.org_id, p.photo.fileId, "original").catch(() => null));
      if (got) {
        photoDigest = sha(got.bytes);
        if (state.get(k)?.photo_digest !== photoDigest) photo = { mime: got.mimeType, data: Buffer.from(got.bytes).toString("base64") };
      }
    }
    const files = await attachedFiles(link.org_id, ref.entity_kind, ref.id);
    const children = await childRowsOf(link.org_id, ref.entity_kind, ref.id);
    const body = { origin: { kind: ref.entity_kind, id: ref.id }, title: p.title, fields: p.fields, metadata: p.metadata, place: p.place, photo_digest: photoDigest, changed_since: changedSince, files, ...(Object.keys(children).length ? { children } : {}) };
    const digest = sha(JSON.stringify({ format: MIRROR_FORMAT, ...body }));
    if (state.get(k)?.digest === digest && !photo) continue;
    // A file's bytes go once; a later pass names it and the copy keeps it.
    const had = new Set(state.get(k)?.file_keys ?? []);
    const fileData: Record<string, string> = {};
    for (const f of files) {
      if (had.has(f.key)) continue;
      const got = await platform().files.read(link.org_id, f.key, "original").catch(() => null);
      if (!got) continue;
      if (got.bytes.byteLength > FILE_CAP_BYTES) {
        console.warn(`[share] ${linkId}: ${f.filename} is over ${FILE_CAP_BYTES / 1024 / 1024} MB, so it stays with the original`);
        continue;
      }
      fileData[f.key] = Buffer.from(got.bytes).toString("base64");
    }
    await enqueueShareOp(linkId, "mirror.upsert", { ...body, ...(photo ? { photo } : {}), file_data: fileData });
    await save(ref.entity_kind, ref.id, digest, photoDigest, files.filter((f) => had.has(f.key) || f.key in fileData).map((f) => f.key));
    sent++;
  }
  for (const [k, row] of state) {
    if (row.entity_kind === SHAPE_KEY || inScope.has(k)) continue;
    await enqueueShareOp(linkId, "mirror.remove", { origin: { kind: row.entity_kind, id: row.entity_id } });
    await meta.deleteFrom("share_mirror_state").where("link_id", "=", linkId).where("entity_kind", "=", row.entity_kind).where("entity_id", "=", row.entity_id).execute();
    removed++;
  }
  await holdForTests(link.org_id, "owner-pass");
  await meta.updateTable("share_links").set({ mirrored_at: new Date() }).where("id", "=", linkId).execute();
  return { sent, removed };
}

/** Run a share's mirror now, one at a time per share across processes. */
export async function mirrorShareNow(linkId: string): Promise<{ sent: number; removed: number } | null> {
  let out: { sent: number; removed: number } | null = null;
  const run = await runExclusive(`share.mirror.${linkId}`, async () => {
    out = await mirrorShare(linkId);
  });
  return run.ran ? out : null;
}

/** The owner changed what a share holds (its scope, what it shows, a record
 *  in or out): mirror it and hand the change to the other side NOW, and say
 *  whether it got there. A pass already running for the share is waited out
 *  rather than skipped, because it may have read the share before this
 *  change; skipping left the change to the box's next loop, behind every
 *  other share due on it, and under load a friend still saw a thing a
 *  minute after it was taken out of a share (#5340, #5391). Bounded: a slow
 *  or unreachable other side answers delivered: false, and the outbox and
 *  the loop carry on from there. */
export async function mirrorAndDeliverNow(linkId: string, waitMs = 20_000): Promise<{ delivered: boolean; error: string | null; sent: number }> {
  const until = Date.now() + waitMs;
  for (;;) {
    const run = await runExclusive(`share.mirror.${linkId}`, async () => {
      await mirrorShare(linkId);
    });
    if (run.ran) break;
    if (Date.now() > until) return { delivered: false, error: null, sent: 0 };
    await new Promise((res) => setTimeout(res, 200));
  }
  // Preparing the mirror cannot spend the wait for an already running delivery.
  const flushed = await flushShareLinkNow(linkId, waitMs);
  const left = await meta
    .selectFrom("share_outbox")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("link_id", "=", linkId)
    .where("sent_at", "is", null)
    .executeTakeFirst();
  const delivered = !flushed.error && Number(left?.n ?? 0) === 0;
  // An owner told "not yet" is worth one line: CI's api log is the only trace
  // a run leaves of why (run 41902 had none).
  if (!delivered) console.warn(`[share] ${linkId}: a change has not reached the other side yet (${flushed.error ?? `${left?.n ?? 0} waiting`})`);
  return { delivered, error: flushed.error, sent: flushed.sent };
}

/** Something changed in a workspace: its mirrored shares are due a pass.
 *  One indexed update, matching nothing in a workspace that shares nothing;
 *  no cache, so a share set up a moment ago (in any process) is never
 *  missed. */
// Coalesced per workspace (lib/per-key-coalesce.ts, #5969): every activity row and every event calls it, and
// an import logs a row per record. One update in flight per workspace, one trailing.
export const noteWorkspaceChanged = perKeyCoalesced(async (orgId: string): Promise<void> => {
  const r = await meta
    .updateTable("share_links")
    .set({ mirror_due_at: new Date() })
    .where("org_id", "=", orgId)
    .where("side", "=", "owner")
    .where("status", "=", "active")
    .where("mirror_due_at", "is", null)
    .where(sql<boolean>`settings ? 'scope'`)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows ?? 0) > 0) kickShareSync();
});

/** The mirrors that are due: a change a few seconds old (so a burst of edits
 *  is one pass), or a day since the last one (the nightly reconcile). */
export async function mirrorDueShares(): Promise<void> {
  const settle = new Date(Date.now() - 5_000);
  const day = new Date(Date.now() - 86_400_000);
  const due = await meta
    .selectFrom("share_links")
    .select("id")
    .where("side", "=", "owner")
    .where("status", "=", "active")
    .where(sql<boolean>`settings ? 'scope'`)
    .where((eb) => eb.or([eb("mirror_due_at", "<=", settle), eb("mirrored_at", "is", null), eb("mirrored_at", "<", day)]))
    .limit(50)
    .execute();
  for (const { id } of due) await mirrorShareNow(id).catch((err) => console.error(`[share] mirror of ${id} failed:`, err));
}

// ── The share's side ─────────────────────────────────────────────────────

export const originRef = (link: ShareLinkRow, kind: string, id: string) => `${link.id}/${kind}/${id}`;

export async function copyOf(orgId: string, kind: string, ref: string): Promise<string | null> {
  const w = await platform().entities.getWriter(orgId, kind);
  if (w?.findByKey) return w.findByKey(orgId, { field: ORIGIN_REF_KEY, metadata: true }, ref);
  const all = await platform().entities.listAll(orgId, kind, { filter: { [ORIGIN_REF_KEY]: ref }, include_retired: true }, undefined, { cap: 2 });
  return all.items[0]?.id ?? null;
}

/** The one way a copy is made: always carrying where it came from
 *  (lint:mirror-copies-carry-origin). */
async function createMirrorCopy(link: ShareLinkRow, kind: string, ref: string, fields: Record<string, unknown>, metadata: Record<string, unknown>): Promise<string> {
  const w = await copyWriter(link, kind);
  if (!w) throw new Error(`the share space cannot hold ${kind} yet`);
  return w.create(link.org_id, { ...fields, metadata: { ...metadata, [ORIGIN_REF_KEY]: ref } });
}

/** The writer a share space's copies are written with: the kind's own, or
 *  its endpoints called as the share space's person (kind-writer.ts), the
 *  same way a sent record is written. */
async function copyWriter(link: ShareLinkRow, kind: string): Promise<EntityWriter | null> {
  if (!link.created_by) return platform().entities.getWriter(link.org_id, kind);
  return writerFor(link.org_id, kind, link.created_by);
}

/** The places a copy is in, made in the share space as they are named:
 *  only those places and their parents, never the owner's whole tree. */
async function ensurePlace(orgId: string, path: string[]): Promise<string | null> {
  const w = await platform().entities.getWriter(orgId, "core-locations:location");
  if (!w) return null;
  let parent: string | null = null;
  for (const name of path) {
    try {
      // NOT-A-COPY: a place the copy is put in, made by its name, not a copy of a record
      parent = await w.create(orgId, { name, parent_id: parent });
    } catch (err) {
      if (err instanceof DuplicateRecordError) parent = err.existingId;
      else throw err;
    }
  }
  return parent;
}

/** Keys of a copy that are the mirror's own bookkeeping, never the friend's
 *  to change. */
export const COPY_BOOKKEEPING = new Set([ORIGIN_REF_KEY, "origin_place", "image_path", "origin_files"]);

type SentFile = { key: string; role: string | null; filename: string; mime: string; sort_order: number };

/** The copy's attached files, as the owner's record has them: each one the
 *  owner sent is attached with its role (a Pattern's PDF as its pattern
 *  file), and one the owner took off is taken off. Which owner file each
 *  local file is stays on the copy (`origin_files`), the mirror's own
 *  bookkeeping (#6056). */
async function carryFiles(link: ShareLinkRow, kind: string, copyId: string, files: SentFile[], data: Record<string, string>): Promise<void> {
  const [module, type] = (await baseKindOf(link.org_id, kind)).split(":", 2);
  if (!module || !type) return;
  const source = { source_module: module, source_type: type, source_id: copyId };
  const copy = await lookup(link.org_id, kind, copyId);
  const md = ((copy?.fields as Record<string, unknown> | undefined)?.metadata ?? {}) as Record<string, unknown>;
  const had = (md.origin_files && typeof md.origin_files === "object" ? md.origin_files : {}) as Record<string, string>;
  const now: Record<string, string> = {};
  for (const f of files) {
    let fileId: string | null = had[f.key] ?? null;
    if (!fileId && data[f.key]) fileId = (await platform().files.write(link.org_id, new Uint8Array(Buffer.from(data[f.key]!, "base64")), { filename: f.filename, mimeType: f.mime }))?.fileId ?? null;
    if (!fileId) continue;
    await platform().files.attach(link.org_id, { fileId, ...source, role: f.role, sort_order: f.sort_order });
    now[f.key] = fileId;
  }
  const gone = new Set(Object.entries(had).filter(([k]) => !(k in now)).map(([, id]) => id));
  if (gone.size) for (const a of (await platform().files.listAttachments(link.org_id, source)) ?? []) if (gone.has(a.fileId)) await platform().files.detach(link.org_id, a.id);
  if (JSON.stringify(now) !== JSON.stringify(had)) await platform().entities.mergeMetadata(link.org_id, kind, copyId, { origin_files: now });
}

/** A copy as the mirror just left it, read back from the copy itself (so a
 *  value the module normalised is what later reads compare with): a later
 *  difference is the friend's own edit. */
type Unsent = { fields: Record<string, unknown>; metadata: Record<string, unknown> };

/** The fields of a copy the friend changed that have not gone back yet, with
 *  what each was based on. */
async function unsentEdits(link: ShareLinkRow, originKind: string, originId: string, copyId: string): Promise<Unsent> {
  const out: Unsent = { fields: {}, metadata: {} };
  const base = await meta.selectFrom("share_copy_base").select(["fields", "metadata"]).where("link_id", "=", link.id).where("origin_kind", "=", originKind).where("origin_id", "=", originId).executeTakeFirst();
  if (!base) return out;
  const copy = await lookup(link.org_id, originKind, copyId);
  if (!copy) return out;
  const f = (copy.fields ?? {}) as Record<string, unknown>;
  const m = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const [k, was] of Object.entries((base.fields ?? {}) as Record<string, unknown>)) if (!same(f[k], was)) out.fields[k] = was;
  for (const [k, was] of Object.entries((base.metadata ?? {}) as Record<string, unknown>)) if (!same(m[k], was)) out.metadata[k] = was;
  return out;
}

async function recordCopyBase(
  link: ShareLinkRow,
  originKind: string,
  originId: string,
  copyId: string,
  fieldKeys: string[],
  metadataKeys: string[],
  unsent: Unsent = { fields: {}, metadata: {} },
  ownerChanged: Record<string, unknown> = {},
): Promise<void> {
  const copy = await lookup(link.org_id, originKind, copyId);
  if (!copy) return;
  const f = (copy.fields ?? {}) as Record<string, unknown>;
  const m = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
  const at = (bag: Record<string, unknown>, held: Record<string, unknown>, k: string) => (k in held ? held[k] : (bag[k] ?? null));
  // A custom field is kept once, in metadata, though a list reads it out at
  // the top level too: else one edit would go back as two.
  const fields = Object.fromEntries(fieldKeys.filter((k) => !COPY_BOOKKEEPING.has(k) && !metadataKeys.includes(k)).map((k) => [k, at(f, unsent.fields, k)]));
  const metadata = Object.fromEntries(metadataKeys.filter((k) => !COPY_BOOKKEEPING.has(k)).map((k) => [k, at(m, unsent.metadata, k)]));
  await meta
    .insertInto("share_copy_base")
    .values({ link_id: link.id, origin_kind: originKind, origin_id: originId, copy_kind: originKind, copy_id: copyId, fields: JSON.stringify(fields) as never, metadata: JSON.stringify(metadata) as never, owner_changed: JSON.stringify(ownerChanged) as never })
    .onConflict((oc) =>
      oc.columns(["link_id", "origin_kind", "origin_id"]).doUpdateSet({ copy_id: copyId, fields: JSON.stringify(fields) as never, metadata: JSON.stringify(metadata) as never, owner_changed: JSON.stringify(ownerChanged) as never, updated_at: new Date() }),
    )
    .execute();
}

/** Test-only: hold the mirror on one workspace at a point, so a test can
 *  land an edit exactly inside a pass. Set through the test-support door;
 *  `reached` is the positive control. One hold and one count PER WORKSPACE:
 *  a single hold for the whole api was replaced, and its count reset, by
 *  another test file setting its own while CI ran them side by side, so a
 *  test's pass never reached a hold that was no longer there (#5396). */
export type ApplyPoint = "before-write" | "after-write" | "owner-pass" | "edits-pass" | "owner-edit-write";
const applyHolds = new Map<string, { at: ApplyPoint; ms: number }>();
const holdsReached = new Map<string, number>();
// Taking a hold away lets a pass already waiting in it go at once: a test
// that releases it never pays the rest of the hold's time.
const heldPasses = new Map<string, Set<() => void>>();
const release = (orgId: string) => {
  for (const go of heldPasses.get(orgId) ?? []) go();
  heldPasses.delete(orgId);
};
export function setMirrorApplyHoldForTests(h: { orgId: string; at: ApplyPoint; ms: number } | null): void {
  if (!h) {
    for (const orgId of [...heldPasses.keys()]) release(orgId);
    applyHolds.clear();
    holdsReached.clear();
    return;
  }
  if (h.ms > 0) {
    applyHolds.set(h.orgId, { at: h.at, ms: Math.min(h.ms, 30_000) });
    holdsReached.set(h.orgId, 0);
  } else {
    applyHolds.delete(h.orgId);
    release(h.orgId);
  }
}
/** How often a hold was reached: one workspace's, or every workspace's together. */
export const mirrorApplyHoldReached = (orgId?: string): number =>
  orgId ? (holdsReached.get(orgId) ?? 0) : [...holdsReached.values()].reduce((n, x) => n + x, 0);
export async function holdForTests(orgId: string, at: ApplyPoint): Promise<void> {
  const h = applyHolds.get(orgId);
  if (!h || h.at !== at) return;
  holdsReached.set(orgId, (holdsReached.get(orgId) ?? 0) + 1);
  await new Promise<void>((resolve) => {
    const waiting = heldPasses.get(orgId) ?? new Set<() => void>();
    heldPasses.set(orgId, waiting);
    const go = () => {
      clearTimeout(timer);
      waiting.delete(go);
      resolve();
    };
    const timer = setTimeout(go, h.ms);
    waiting.add(go);
  });
}

async function baseOf(link: ShareLinkRow, originKind: string, originId: string): Promise<Bags | null> {
  const b = await meta.selectFrom("share_copy_base").select(["fields", "metadata"]).where("link_id", "=", link.id).where("origin_kind", "=", originKind).where("origin_id", "=", originId).executeTakeFirst();
  return b ? { fields: (b.fields ?? {}) as Record<string, unknown>, metadata: (b.metadata ?? {}) as Record<string, unknown> } : null;
}

async function activityMark(orgId: string): Promise<number> {
  const r = await meta.selectFrom("activity_log").select((eb) => eb.fn.max("id").as("id")).where("org_id", "=", orgId).executeTakeFirst();
  return Number(r?.id ?? 0);
}

/** The mirror's write is not a compare-and-set: a person who edited the copy
 *  while it ran would lose the edit, overwritten or folded into the base
 *  (share-held-edits.ts). Their writes since the apply began are put back
 *  and measured from what they were based on, so they go to the owner's side
 *  and meet the owner's change there as a conflict. The mirror's own writes
 *  log no activity; any row by a person is theirs. */
async function keepEditsMadeDuringApply(link: ShareLinkRow, kind: string, originId: string, copyId: string, mark: number, before: Bags, sent: Bags): Promise<void> {
  const writes = await meta
    .selectFrom("activity_log")
    .select(["diff"])
    .where("org_id", "=", link.org_id)
    .where("entity_id", "=", copyId)
    .where("id", ">", mark)
    .where("user_id", "is not", null)
    .orderBy("id")
    .execute();
  if (!writes.length) return;
  const after = await baseOf(link, kind, originId);
  if (!after) return;
  const { restore, base } = editsMadeDuringApply(writes, before, after, sent);
  if (!Object.keys(restore.fields).length && !Object.keys(restore.metadata).length) return;
  const w = await copyWriter(link, kind);
  if (!w) return;
  if (Object.keys(restore.fields).length) await w.update(link.org_id, copyId, restore.fields);
  if (Object.keys(restore.metadata).length) {
    if (w.mergeMetadata) await w.mergeMetadata(link.org_id, copyId, restore.metadata);
    else {
      const copy = await lookup(link.org_id, kind, copyId);
      const m = (((copy?.fields ?? {}) as Record<string, unknown>).metadata ?? {}) as Record<string, unknown>;
      // read-then-write: a kind with no mergeMetadata writes its metadata whole; the read is the moment before
      await w.update(link.org_id, copyId, { metadata: { ...m, ...restore.metadata } });
    }
  }
  await meta
    .updateTable("share_copy_base")
    .set({ fields: JSON.stringify({ ...after.fields, ...base.fields }) as never, metadata: JSON.stringify({ ...after.metadata, ...base.metadata }) as never, updated_at: new Date() })
    .where("link_id", "=", link.id)
    .where("origin_kind", "=", kind)
    .where("origin_id", "=", originId)
    .execute();
  await meta.updateTable("share_links").set({ edits_due_at: new Date() }).where("id", "=", link.id).execute();
  kickShareSync(4_000);
}

/** The keys the copy was last sent and is not sent now, each cleared. */
async function revokedKeys(link: ShareLinkRow, originKind: string, originId: string, fields: Record<string, unknown>, metadata: Record<string, unknown>): Promise<Unsent> {
  const out: Unsent = { fields: {}, metadata: {} };
  const base = await meta.selectFrom("share_copy_base").select(["fields", "metadata"]).where("link_id", "=", link.id).where("origin_kind", "=", originKind).where("origin_id", "=", originId).executeTakeFirst();
  if (!base) return out;
  for (const k of Object.keys((base.fields ?? {}) as Record<string, unknown>)) if (!(k in fields) && !COPY_BOOKKEEPING.has(k)) out.fields[k] = null;
  for (const k of Object.keys((base.metadata ?? {}) as Record<string, unknown>)) if (!(k in metadata) && !COPY_BOOKKEEPING.has(k)) out.metadata[k] = null;
  return out;
}

async function slugOf(orgId: string): Promise<string> {
  return (await meta.selectFrom("orgs").select("slug").where("id", "=", orgId).executeTakeFirstOrThrow()).slug;
}

export function registerShareMirrorOps(): void {
  const registerCopyOp = (op: string, apply: (link: ShareLinkRow, p: Record<string, unknown>) => Promise<void>) =>
    registerShareOp(op, async (link, p) => {
      // Waited for: the friend's edits pass holds the copy a moment after
      // every change in the share space (share-copy-state.ts).
      const applied = await withShareCopyState(link.id, () => apply(link, p), { waitMs: 10_000 });
      if (applied === null) throw new Error("The shared copy is being checked for edits. Try syncing again.");
    });
  registerShareOp("mirror.shape", async (link, p) => {
    const manifest = BlueprintManifest.parse(p.manifest);
    const sess = { id: (await meta.selectFrom("share_links").select("created_by").where("id", "=", link.id).executeTakeFirst())?.created_by ?? "", auth_method: "system" as const };
    await applyBlueprint(link.org_id, sess, manifest);
  });

  registerCopyOp("mirror.upsert", async (link, p) => {
    const origin = p.origin as { kind?: string; id?: string } | undefined;
    if (!origin?.kind || !origin.id) throw new Error("a mirrored record without its origin");
    const kind = origin.kind;
    const ref = originRef(link, kind, origin.id);
    const place = (p.place ?? {}) as { text?: string | null; path?: string[] | null };
    const sentFields: Record<string, unknown> = { ...((p.fields as Record<string, unknown>) ?? {}), name: p.title };
    const sentMetadata: Record<string, unknown> = { ...((p.metadata as Record<string, unknown>) ?? {}), origin_place: place.text ?? null };
    const photo = p.photo as { mime?: string; data?: string } | undefined;
    if (photo?.data && photo.mime) {
      const w = await platform().files.write(link.org_id, new Uint8Array(Buffer.from(photo.data, "base64")), { filename: "photo", mimeType: photo.mime });
      if (w) sentFields.image_path = rawPathFor(await slugOf(link.org_id), w.fileId);
    }
    let fields = { ...sentFields };
    let metadata = { ...sentMetadata };
    let id = await copyOf(link.org_id, kind, ref);
    let unsent: Unsent = { fields: {}, metadata: {} };
    const mark = id ? await activityMark(link.org_id) : null;
    const before = id ? await baseOf(link, kind, origin.id) : null;
    let sent: Bags | null = null;
    // The version the mirror wrote, when the kind can compare-and-set: the
    // write then never lands on a copy the friend changed since it was read.
    let written: string | null = null;
    let w: EntityWriter | null = null;
    if (!id) {
      id = await createMirrorCopy(link, kind, ref, fields, metadata);
    } else {
      w = await copyWriter(link, kind);
      if (!w) throw new Error(`the share space cannot hold ${kind} yet`);
      for (let tries = 0; ; tries++) {
        // The version first, then the copy: a write after this read moves it.
        const version = w.version && w.updateIf ? await w.version(link.org_id, id) : null;
        fields = { ...sentFields };
        metadata = { ...sentMetadata };
        // An edit the friend made that has not gone back yet stays: the owner's
        // change does not land over it, and it goes back measured against what
        // it was based on, so the owner's side sees both.
        unsent = await unsentEdits(link, kind, origin.id, id);
        for (const k of Object.keys(unsent.fields)) delete fields[k];
        const current = await lookup(link.org_id, kind, id);
        const m = ((current?.fields as Record<string, unknown> | undefined)?.metadata ?? {}) as Record<string, unknown>;
        for (const k of Object.keys(unsent.metadata)) metadata[k] = m[k] ?? null;
        // What the owner's side sent IS the copy. An update merges, so a field
        // it sent last time and no longer sends (a toggle turned off: private
        // notes, prices, a restricted field) is cleared here, or the friend
        // keeps reading it (#4688).
        const gone = await revokedKeys(link, kind, origin.id, { ...fields, ...unsent.fields }, metadata);
        const payload = { ...fields, ...gone.fields, metadata: { ...metadata, ...gone.metadata, [ORIGIN_REF_KEY]: ref } };
        await holdForTests(link.org_id, "before-write");
        if (version === null || !w.updateIf) {
          // read-then-write: a kind with no updateIf; keepEditsMadeDuringApply below puts back what this overwrote
          await w.update(link.org_id, id, payload);
          break;
        }
        written = await w.updateIf(link.org_id, id, payload, version);
        if (written) break;
        // The friend changed the copy since it was read: read it again, and
        // their edit is now one not yet sent, which stays.
        if (tries >= 4) throw new Error(`the copy ${id} kept changing while it was being updated`);
      }
      await holdForTests(link.org_id, "after-write");
      sent = await baseOf(link, kind, origin.id);
    }
    await recordCopyBase(link, kind, origin.id, id, [...Object.keys(fields), ...Object.keys(unsent.fields)], Object.keys(metadata), unsent, (p.changed_since ?? {}) as Record<string, unknown>);
    if (place.path?.length) {
      const where = await ensurePlace(link.org_id, place.path);
      if (where) await platform().placement.place({ orgId: link.org_id, containee: { kind, id }, container: { kind: "core-locations:location", id: where } });
    } else {
      await platform().placement.remove({ orgId: link.org_id, containee: { kind, id } }).catch(() => undefined);
    }
    // Nothing to repair when the copy is still at the version the mirror
    // wrote: the base it just recorded was read from exactly that write. A
    // write after it (or a kind with no compare-and-set) is looked for in
    // the activity log and kept.
    const clean = written !== null && w?.version && (await w.version(link.org_id, id)) === written;
    if (!clean && mark !== null && before) await keepEditsMadeDuringApply(link, kind, origin.id, id, mark, before, sent ?? before);
    if (Array.isArray(p.files)) await carryFiles(link, kind, id, p.files as SentFile[], (p.file_data ?? {}) as Record<string, string>);
    // The record's own rows, made exactly what the owner's are (#6252).
    if (p.children && typeof p.children === "object") {
      const defs = shareChildrenFor(await baseKindOf(link.org_id, kind));
      for (const [name, rows] of Object.entries(p.children as Record<string, unknown>)) {
        const def = defs.find((d) => d.name === name);
        if (def && Array.isArray(rows)) await def.write(link.org_id, id, rows as Array<Record<string, unknown>>);
      }
    }
  });

  registerCopyOp("mirror.remove", async (link, p) => {
    const origin = p.origin as { kind?: string; id?: string } | undefined;
    if (!origin?.kind || !origin.id) return;
    const id = await copyOf(link.org_id, origin.kind, originRef(link, origin.kind, origin.id));
    if (!id) return;
    // The writer the copy was made with: a kind written through its
    // endpoints (a project) was never removed here when only a native
    // writer was looked for.
    const w = await copyWriter(link, origin.kind);
    await w?.delete(link.org_id, id);
    await meta.deleteFrom("share_copy_base").where("link_id", "=", link.id).where("origin_kind", "=", origin.kind).where("origin_id", "=", origin.id).execute();
  });
}

