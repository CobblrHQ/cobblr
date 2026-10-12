// The friend's edits, coming back (#4627 §2.4-2.7,
// docs/design-decisions/share-spaces.md §8).
//
// In the share space the friend edits the copies directly, at their own speed.
// That side finds each field that now differs from what the mirror last left
// (share_copy_base) and sends it to the owner as `copy.edited`, one change per
// field: from (what the copy said), to (what the friend made it).
//
// The owner's side decides, field by field, against the record as it is now:
//   - the record must still be shared, and the field one the friend can see
//     and is allowed to change (never a reference, a price or a private note
//     the share does not show, nor the mirror's own bookkeeping);
//   - the record already says `to`: nothing to do;
//   - it no longer says `from` (the owner changed it since): a conflict, kept
//     for the owner to decide, never last-write-wins;
//   - otherwise a Direct share applies it at once, credited to the friend and
//     undoable; a Suggest share keeps it pending.
// Every field the friend changed is a row in share_suggestions, so an applied
// edit can be undone and a pending one accepted or rejected.

import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { classifyField, fieldVisible, readVisibility } from "@cobblr/platform-contract/share-scope";
import { meta } from "../db/meta.js";
import type { ShareSuggestionStatus } from "../db/schema.js";
import { runVia } from "../lib/request-context.js";
import * as activity from "./activity.js";
import { baseKindOf, lookup } from "./entities.js";
import { describeChanges, saidAmount } from "./history-describe.js";
import { gatedFields } from "./scope-eval.js";
import { COPY_BOOKKEEPING, fieldsOf, holdForTests, isReference, mirrorAndDeliverNow, noteWorkspaceChanged } from "./share-mirror.js";
import { enqueueShareOp, getShareLink, kickShareSync, registerShareOp, type ShareLinkRow } from "./share-sync.js";
import { withShareCopyState } from "./share-copy-state.js";
import { runExclusive } from "./exclusive.js";
import { noteShare } from "./share-notices.js";
import { sendAdditions } from "./share-additions.js";
import { perKeyCoalesced } from "../lib/per-key-coalesce.js";

export type EditMode = "suggest" | "direct";
export const readEditMode = (settings: unknown): EditMode => ((settings as { edit_mode?: unknown } | null)?.edit_mode === "direct" ? "direct" : "suggest");

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

interface FieldChange {
  field: string;
  in_metadata: boolean;
  from: unknown;
  to: unknown;
}

// ── The share space's side ───────────────────────────────────────────────

/** Something changed in a workspace: if it is a share space, its links are
 *  due a look for edits. One indexed update, matching nothing in a workspace
 *  that is not one; no cache, so a share accepted a moment ago (in this
 *  process or another) is never missed. */
// Coalesced per workspace, as noteWorkspaceChanged is (lib/per-key-coalesce.ts, #5969).
export const noteCopiesChanged = perKeyCoalesced(async (orgId: string): Promise<void> => {
  const r = await meta
    .updateTable("share_links")
    .set({ edits_due_at: new Date() })
    .where("org_id", "=", orgId)
    .where("side", "=", "share")
    .where("status", "=", "active")
    .where("edits_due_at", "is", null)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows ?? 0) > 0) kickShareSync(4_000);
});

/** Send back every field the friend changed on a link's copies since the
 *  mirror last left them. */
export async function sendCopyEdits(linkId: string): Promise<{ sent: number }> {
  return (await withShareCopyState(linkId, () => sendCopyEditsPass(linkId), { skipIfBusy: "the mirror owns the copy and base; edits_due_at stays set for the next pass" })) ?? { sent: 0 };
}

async function sendCopyEditsPass(linkId: string): Promise<{ sent: number }> {
  const link = await getShareLink(linkId);
  if (!link || link.side !== "share" || link.status !== "active") return { sent: 0 };
  await meta.updateTable("share_links").set({ edits_due_at: null }).where("id", "=", linkId).execute();
  await holdForTests(link.org_id, "edits-pass");
  const bases = await meta.selectFrom("share_copy_base").selectAll().where("link_id", "=", linkId).execute();
  let sent = 0;
  for (const b of bases) {
    const copy = await lookup(link.org_id, b.copy_kind, b.copy_id).catch(() => null);
    if (!copy) continue;
    const f = (copy.fields ?? {}) as Record<string, unknown>;
    const m = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
    const changes: FieldChange[] = [];
    const baseFields = (b.fields ?? {}) as Record<string, unknown>;
    const baseMeta = (b.metadata ?? {}) as Record<string, unknown>;
    for (const [k, was] of Object.entries(baseFields)) if (!same(f[k], was)) changes.push({ field: k, in_metadata: false, from: was, to: f[k] ?? null });
    for (const [k, was] of Object.entries(baseMeta)) if (!same(m[k], was)) changes.push({ field: k, in_metadata: true, from: was, to: m[k] ?? null });
    if (!changes.length) continue;
    await enqueueShareOp(linkId, "copy.edited", { origin: { kind: b.origin_kind, id: b.origin_id }, changes });
    const nextFields = { ...baseFields };
    const nextMeta = { ...baseMeta };
    for (const c of changes) (c.in_metadata ? nextMeta : nextFields)[c.field] = c.to;
    await meta
      .updateTable("share_copy_base")
      .set({ fields: JSON.stringify(nextFields) as never, metadata: JSON.stringify(nextMeta) as never, updated_at: new Date() })
      .where("link_id", "=", linkId)
      .where("origin_kind", "=", b.origin_kind)
      .where("origin_id", "=", b.origin_id)
      .execute();
    sent++;
  }
  sent += await sendAdditions(link, [...new Set(bases.map((b) => b.copy_kind))]);
  return { sent };
}

/** The share spaces with edits waiting to go: a change a few seconds old,
 *  so a friend typing in a field is one change, not one per keystroke. */
export async function sendDueCopyEdits(): Promise<void> {
  const settle = new Date(Date.now() - 3_000);
  const due = await meta.selectFrom("share_links").select("id").where("side", "=", "share").where("status", "=", "active").where("edits_due_at", "<=", settle).limit(50).execute();
  for (const { id } of due) {
    // SKIP-IF-BUSY OK: another process is sending this link's edits; edits_due_at stays set only if a change lands after it read
    await runExclusive(`share.edits.${id}`, async () => void (await sendCopyEdits(id))).catch((err) => console.error(`[share] edits of ${id} failed:`, err));
  }
}

// ── The owner's side ─────────────────────────────────────────────────────

/** May the friend change this field of this kind, under the share as it
 *  stands? Only what they can see, and never a reference or bookkeeping.
 *  Answers where the field lives: a custom field in the record's metadata,
 *  whatever the other side called it (a list reads custom fields out at the
 *  top level too). */
async function mayChange(orgId: string, kind: string, field: string, settings: Record<string, unknown>): Promise<{ in_metadata: boolean } | null> {
  if (COPY_BOOKKEEPING.has(field) || field.startsWith("_")) return null;
  const defs = await fieldsOf(orgId, kind);
  const def = defs.find((d) => d.name === field);
  // A field the record works out itself (stock, a count of uses) is never
  // the friend's to change: its value moves on both sides as stock does, and
  // an "edit" of it was the reading drifting, offered as a Stock suggestion
  // nobody made (#6039).
  if (!def || def.read_only || isReference(field, def)) return null;
  const gated = new Set((await gatedFields(orgId)).map((f) => f.name));
  if (!fieldVisible(classifyField(def, gated), field, readVisibility(settings.visibility))) return null;
  const custom = (await platform().entities.fieldsFor(orgId, kind)).some((d) => d.name === field);
  return { in_metadata: custom };
}

const valueIn = (fields: Record<string, unknown>, c: { field: string; in_metadata: boolean }) =>
  c.in_metadata ? ((fields.metadata && typeof fields.metadata === "object" ? fields.metadata : {}) as Record<string, unknown>)[c.field] ?? null : fields[c.field] ?? null;

/** Write one field of a record as the friend, so its history names them. */
async function writeField(orgId: string, kind: string, id: string, c: { field: string; in_metadata: boolean }, value: unknown, by: string, before: Record<string, unknown>): Promise<void> {
  await runVia({ kind: "share", label: by }, async () => {
    if (c.in_metadata) {
      const ok = await platform().entities.mergeMetadata(orgId, kind, id, { [c.field]: value });
      if (!ok) throw new Error("this kind of record cannot be changed from a share");
    } else {
      const w = await platform().entities.getWriter(orgId, kind);
      if (!w) throw new Error("this kind of record cannot be changed from a share");
      await w.update(orgId, id, { [c.field]: value });
    }
    // Logged under the module's kind, as its own writer logs: the record's
    // History reads a collection's item ("3d-printers:item") as that kind,
    // and an edit logged as the collection's was never found there (#4680, #4690).
    const [module, entityType] = (await baseKindOf(orgId, kind)).split(":", 2);
    const patch = c.in_metadata ? { metadata: { [c.field]: value } } : { [c.field]: value };
    const was = c.in_metadata ? { metadata: { [c.field]: valueIn(before, c) } } : { [c.field]: valueIn(before, c) };
    await activity.log({ orgId, userId: null, action: "updated", ref: { module: module ?? null, entityType: entityType ?? kind, entityId: id }, diff: patch, before: was });
  });
  await noteWorkspaceChanged(orgId);
}

/** One field the friend changed arrives on the owner's side. */
export async function receiveEdit(link: ShareLinkRow & { settings?: unknown }, kind: string, id: string, change: FieldChange): Promise<ShareSuggestionStatus | null> {
  const settings = ((link.settings ?? (await meta.selectFrom("share_links").select("settings").where("id", "=", link.id).executeTakeFirst())?.settings) ?? {}) as Record<string, unknown>;
  const shared = await meta.selectFrom("share_mirror_state").select("entity_id").where("link_id", "=", link.id).where("entity_kind", "=", kind).where("entity_id", "=", id).executeTakeFirst();
  if (!shared) return null;
  const may = await mayChange(link.org_id, kind, change.field, settings);
  if (!may) return null;
  const c: FieldChange = { ...change, in_metadata: may.in_metadata };
  const rec = await lookup(link.org_id, kind, id);
  if (!rec) return null;
  const now = (rec.fields ?? {}) as Record<string, unknown>;
  const current = valueIn(now, c);
  const by = link.peer_name ?? "Someone you share with";
  // A newer change to a field still waiting replaces what it proposes; what
  // it was based on stays the first one's.
  const waiting = await meta
    .selectFrom("share_suggestions")
    .select(["id", "base"])
    .where("link_id", "=", link.id)
    .where("entity_kind", "=", kind)
    .where("entity_id", "=", id)
    .where("field", "=", c.field)
    .where("in_metadata", "=", c.in_metadata)
    .where("status", "in", ["pending", "conflict"])
    .executeTakeFirst();
  const base = waiting ? waiting.base : c.from;
  if (same(current, c.to)) {
    if (waiting) {
      // The friend's copy is back at what this workspace holds, so nothing is
      // left to decide. Said in the log: a suggestion that vanished before the
      // owner saw it (#5119, main 2026-10-08) is otherwise silent.
      console.info(`[share] ${by}'s ${c.field} on ${kind} ${id} now matches this workspace's: suggestion ${waiting.id} closes`);
      await meta.updateTable("share_suggestions").set({ status: "accepted", decided_at: new Date() }).where("id", "=", waiting.id).execute();
    }
    return null;
  }
  const conflict = !same(current, base);
  const status: ShareSuggestionStatus = conflict ? "conflict" : readEditMode(settings) === "direct" ? "applied" : "pending";
  const row = { proposed: JSON.stringify(c.to ?? null) as never, owner_before: JSON.stringify(current ?? null) as never, status, by_name: by, ...(status === "applied" ? { decided_at: new Date() } : {}) };
  // The edit is kept before it is applied: a change the owner cannot see
  // listed is one they cannot undo.
  const rowId = waiting
    ? (await meta.updateTable("share_suggestions").set(row).where("id", "=", waiting.id).execute(), waiting.id)
    : (
        await meta
          .insertInto("share_suggestions")
          .values({ org_id: link.org_id, link_id: link.id, entity_kind: kind, entity_id: id, field: c.field, in_metadata: c.in_metadata, base: JSON.stringify(base ?? null) as never, ...row })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
  if (status === "applied") {
    try {
      await writeField(link.org_id, kind, id, c, c.to, by, now);
    } catch (err) {
      await meta.updateTable("share_suggestions").set({ status: "pending", decided_at: null }).where("id", "=", rowId).execute();
      throw err;
    }
  } else {
    // A running mirror may have snapshotted waiting edits before this row
    // existed. It needs another pass to keep the proposal and tell the friend
    // what the owner's conflicting value is.
    await noteWorkspaceChanged(link.org_id);
  }
  await noteShare(link.id, status === "applied" ? "applied" : "suggested", rec.title);
  return status;
}

export function registerShareEditOps(): void {
  registerShareOp("copy.edited", async (link, p) => {
    const origin = p.origin as { kind?: string; id?: string } | undefined;
    if (!origin?.kind || !origin.id || link.side !== "owner") return;
    const changes = Array.isArray(p.changes) ? (p.changes as FieldChange[]) : [];
    const seen = new Set<string>();
    for (const c of changes) {
      if (!c || typeof c.field !== "string" || seen.has(c.field)) continue;
      seen.add(c.field);
      await receiveEdit(link, origin.kind, origin.id, { field: c.field, in_metadata: c.in_metadata === true, from: c.from ?? null, to: c.to ?? null });
    }
  });
}

export interface ShareEditRow {
  id: string;
  link_id: string;
  entity_kind: string;
  entity_id: string;
  title: string | null;
  field: string;
  in_metadata: boolean;
  base: unknown;
  proposed: unknown;
  owner_before: unknown;
  status: ShareSuggestionStatus;
  by_name: string | null;
  created_at: Date;
  /** The unit the record keeps its quantity in, on a quantity edit, so the
   *  values read "3 m" and not a bare number (#6039). */
  unit?: string | null;
  /** False once the record left the share: the edit is kept for the owner
   *  to accept or drop, and says so. */
  still_shared: boolean;
}

export const OPEN_STATUSES: ShareSuggestionStatus[] = ["pending", "conflict"];

/** A waiting suggestion whose base is no longer what the record says here:
 *  the owner changed the field after the friend did. Marks it a conflict
 *  (with what the record says now) and says so. */
export async function conflictIfChanged(r: { id: string; base: unknown }, current: unknown): Promise<boolean> {
  if (same(current, r.base)) return false;
  await meta.updateTable("share_suggestions").set({ status: "conflict", owner_before: JSON.stringify(current ?? null) as never }).where("id", "=", r.id).where("status", "=", "pending").execute();
  return true;
}

/** Edits from shares, newest first, waiting ones before decided ones: one
 *  share's, one record's, or the whole workspace's. */
export async function listShareEdits(orgId: string, where: { linkId?: string; kind?: string; id?: string; open?: boolean } = {}, limit = 200): Promise<ShareEditRow[]> {
  const rows = await meta
    .selectFrom("share_suggestions as s")
    .leftJoin("share_mirror_state as m", (j) => j.onRef("m.link_id", "=", "s.link_id").onRef("m.entity_kind", "=", "s.entity_kind").onRef("m.entity_id", "=", "s.entity_id"))
    .select(["s.id", "s.link_id", "s.entity_kind", "s.entity_id", "s.field", "s.in_metadata", "s.base", "s.proposed", "s.owner_before", "s.status", "s.by_name", "s.created_at", "m.entity_id as shared_id"])
    .where("s.org_id", "=", orgId)
    // Never an edit (heal-void-share-suggestions.ts, #6038): on no list.
    .where("s.status", "!=", "void")
    .$if(!!where.linkId, (q) => q.where("s.link_id", "=", where.linkId!))
    .$if(!!where.kind && !!where.id, (q) => q.where("s.entity_kind", "=", where.kind!).where("s.entity_id", "=", where.id!))
    .$if(where.open === true, (q) => q.where("s.status", "in", OPEN_STATUSES))
    .orderBy(sql`case when s.status in ('pending','conflict') then 0 else 1 end`)
    .orderBy("s.created_at", "desc")
    .limit(limit)
    .execute();
  const titles = new Map<string, string>();
  const records = new Map<string, Record<string, unknown> | null>();
  const counted = rows.length ? new Map((await platform().entities.listScannableForOrg(orgId)).map((k) => [k.kind, k])) : new Map();
  for (const r of rows) {
    const k = `${r.entity_kind}/${r.entity_id}`;
    if (!records.has(k)) {
      const rec = await lookup(orgId, r.entity_kind, r.entity_id).catch(() => null);
      titles.set(k, rec?.title ?? "");
      records.set(k, (rec?.fields ?? null) as Record<string, unknown> | null);
    }
    // The owner changed the field since the friend's edit: it is a conflict
    // to decide, not an ordinary suggestion to accept (#4692).
    const now = records.get(k);
    if (r.status === "pending" && now && (await conflictIfChanged(r, valueIn(now, r)))) {
      r.status = "conflict";
      r.owner_before = valueIn(now, r);
    }
  }
  return rows.map(({ shared_id, ...r }) => {
    const k = counted.get(r.entity_kind);
    const fields = records.get(`${r.entity_kind}/${r.entity_id}`);
    const unit = k?.qtyField === r.field && k.unitField ? fields?.[k.unitField] : null;
    return { ...r, title: titles.get(`${r.entity_kind}/${r.entity_id}`) || null, still_shared: shared_id !== null, unit: typeof unit === "string" && unit.trim() ? unit.trim() : null };
  });
}

/** The copy follows a decision: the record is sent again now. Its mirror
 *  row stays (cleared, not removed), because that row is also what says the
 *  record is still shared, and an edit arriving before the resend must not
 *  read as one on a record that left. */
async function resendRecord(linkId: string, kind: string, id: string): Promise<void> {
  await meta.updateTable("share_mirror_state").set({ digest: "" }).where("link_id", "=", linkId).where("entity_kind", "=", kind).where("entity_id", "=", id).execute();
  await meta.updateTable("share_links").set({ mirror_due_at: new Date() }).where("id", "=", linkId).execute();
  // DETACHED: the owner's answer is recorded; this waits out a running pass rather than skipping it
  void mirrorAndDeliverNow(linkId).catch((err) => console.error(`[share] mirror of ${linkId} failed:`, err));
}

export type DecideResult = { ok: true; status: ShareSuggestionStatus } | { ok: false; error: string };

export type ShareEditDecision = "accept" | "reject" | "undo" | "reopen";

/** The owner decides on one of the friend's edits: accept or reject one
 *  waiting, undo one applied on a Direct share, or reopen one accepted or
 *  rejected (the way back from either: the record says what it did before,
 *  and the edit waits again). */
export async function decideShareEdit(orgId: string, userId: string | null, editId: string, decision: ShareEditDecision): Promise<DecideResult> {
  const r = await meta.selectFrom("share_suggestions").selectAll().where("id", "=", editId).where("org_id", "=", orgId).executeTakeFirst();
  if (!r) return { ok: false, error: "That edit is not here any more." };
  const rec = await lookup(orgId, r.entity_kind, r.entity_id);
  const now = (rec?.fields ?? {}) as Record<string, unknown>;
  const current = valueIn(now, r);
  const done = async (status: ShareSuggestionStatus) => {
    await meta.updateTable("share_suggestions").set({ status, decided_at: new Date(), decided_by: userId }).where("id", "=", r.id).execute();
    // The friend hears what became of their edit.
    if (status === "accepted" || status === "rejected" || status === "undone") {
      await enqueueShareOp(r.link_id, "edits.decided", { decision: status, title: rec?.title ?? null });
    }
    // The copy follows the decision: the mirror sends this record again.
    await resendRecord(r.link_id, r.entity_kind, r.entity_id);
    return { ok: true as const, status };
  };
  if (decision === "undo") {
    if (r.status !== "applied") return { ok: false, error: "Only an edit that was applied can be undone." };
    if (!rec) return { ok: false, error: "That record is not here any more." };
    if (!same(current, r.proposed)) return { ok: false, error: "It has been changed again since, so undoing this would lose that change." };
    await writeField(orgId, r.entity_kind, r.entity_id, r, r.owner_before, r.by_name ?? "Someone you share with", now);
    return done("undone");
  }
  if (decision === "reopen") {
    if (r.status !== "accepted" && r.status !== "rejected") return { ok: false, error: "Only an edit that was accepted or rejected can wait again." };
    if (r.status === "accepted" && rec) {
      if (!same(current, r.proposed)) return { ok: false, error: "It has been changed again since, so putting it back would lose that change." };
      await writeField(orgId, r.entity_kind, r.entity_id, r, r.owner_before, r.by_name ?? "Someone you share with", now);
    }
    const after = r.status === "accepted" ? r.owner_before : current;
    const status: ShareSuggestionStatus = same(after, r.base) ? "pending" : "conflict";
    await meta.updateTable("share_suggestions").set({ status, decided_at: null, decided_by: null }).where("id", "=", r.id).execute();
    await resendRecord(r.link_id, r.entity_kind, r.entity_id);
    return { ok: true, status };
  }
  if (r.status !== "pending" && r.status !== "conflict") return { ok: false, error: "That edit was already decided." };
  if (decision === "reject") return done("rejected");
  if (!rec) return { ok: false, error: "That record is not here any more." };
  // Accepting a suggestion the owner has since changed under would overwrite
  // their newer value without them choosing to: it waits as a conflict.
  if (r.status === "pending" && (await conflictIfChanged(r, current))) {
    await resendRecord(r.link_id, r.entity_kind, r.entity_id);
    return { ok: false, error: "You changed this since their edit. Choose Take theirs or Keep yours." };
  }
  if (!same(current, r.proposed)) await writeField(orgId, r.entity_kind, r.entity_id, r, r.proposed, r.by_name ?? "Someone you share with", now);
  await meta.updateTable("share_suggestions").set({ owner_before: JSON.stringify(current ?? null) as never }).where("id", "=", r.id).execute();
  return done("accepted");
}

export interface SaidShareEdit extends Omit<ShareEditRow, "base" | "proposed" | "owner_before"> {
  label: string;
  /** What the copy said when the friend changed it. */
  was: string | null;
  /** What they made it. */
  now: string | null;
  /** On a conflict: what the record says here now. */
  yours: string | null;
}

/** A share's edits in words: each field by its label, each value by its
 *  type, through the same describer the record's history uses. */
export async function describeShareEdits(orgId: string, rows: ShareEditRow[]): Promise<SaidShareEdit[]> {
  if (!rows.length) return [];
  const slug = (await meta.selectFrom("orgs").select("slug").where("id", "=", orgId).executeTakeFirstOrThrow()).slug;
  const kindsOf = new Map<string, string[]>();
  for (const r of rows) if (!kindsOf.has(r.entity_kind)) kindsOf.set(r.entity_kind, [r.entity_kind, await baseKindOf(orgId, r.entity_kind)]);
  const said = await describeChanges(
    orgId,
    slug,
    rows.map((r) => ({
      action: "updated",
      kinds: kindsOf.get(r.entity_kind)!,
      diff: { changes: [{ field: r.field, ...(r.in_metadata ? { custom: true as const } : {}), from: r.base, to: r.proposed }, { field: r.field, ...(r.in_metadata ? { custom: true as const } : {}), from: null, to: r.owner_before }] },
    })),
  );
  return Promise.all(rows.map(async (r, i) => {
    const [mine, theirs] = said[i] ?? [];
    const { base: _b, proposed: _p, owner_before: _o, ...rest } = r;
    // A quantity reads in the record's unit: "3 m → 5 m", not "3 → 5" (#6039).
    const inUnit = async (raw: unknown, text: string | null) => {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      return r.unit && Number.isFinite(n) ? saidAmount(orgId, n, r.unit) : text;
    };
    return {
      ...rest,
      label: mine?.label ?? r.field,
      was: await inUnit(r.base, mine?.from?.text ?? null),
      now: await inUnit(r.proposed, mine?.to.text ?? null),
      yours: r.status === "conflict" ? await inUnit(r.owner_before, theirs?.to.text ?? null) : null,
    };
  }));
}

/** On the friend's side: what the owner changed since the friend edited this
 *  copy, field by field, in words. Empty for anything that is not a copy. */
export async function copyNotes(orgId: string, kind: string, id: string): Promise<{ from: string | null; notes: Array<{ field: string; label: string; theirs: string | null }> }> {
  const row = await meta
    .selectFrom("share_copy_base as b")
    .innerJoin("share_links as l", "l.id", "b.link_id")
    .select(["b.owner_changed", "b.metadata", "l.peer_name"])
    .where("l.org_id", "=", orgId)
    .where("b.copy_id", "=", id)
    .executeTakeFirst();
  const changed = (row?.owner_changed ?? {}) as Record<string, unknown>;
  const fields = Object.keys(changed);
  if (!row || !fields.length) return { from: row?.peer_name ?? null, notes: [] };
  const slug = (await meta.selectFrom("orgs").select("slug").where("id", "=", orgId).executeTakeFirstOrThrow()).slug;
  const inMeta = (f: string) => f in ((row.metadata ?? {}) as Record<string, unknown>);
  const [said] = await describeChanges(orgId, slug, [
    { action: "updated", kinds: [kind, await baseKindOf(orgId, kind)], diff: { changes: fields.map((f) => ({ field: f, ...(inMeta(f) ? { custom: true as const } : {}), from: null, to: changed[f] })) } },
  ]);
  const of = (f: string) => said?.find((c) => c.field === f);
  return { from: row.peer_name, notes: fields.map((f) => ({ field: f, label: of(f)?.label ?? f, theirs: of(f)?.to.text ?? null })) };
}
