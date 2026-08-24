// The AI change ledger — the standing rule: auto-apply is only safe standing on
// perfect tracking + undo.
//
// UNDO MEANS THE STATE COMES BACK, not that an opposite operation is performed.
// That distinction is the whole design. Doing the opposite is a new forward
// write: it earns a new id, it re-runs the rules meant for new records, and it
// can produce something that merely resembles what was there. So every change
// records what the record looked like BEFORE it and what it looked like AFTER,
// and undo puts the before back — by id, through the kind's restore seam, with
// no forward-write rule allowed a say, because the state being restored is one
// this workspace already held.
//
//   create → the record is removed
//   update → the whole prior row is written back (not only the fields sent:
//            a write's side effects are part of what it did)
//   delete → the SAME row returns, same id, so everything that pointed at it
//            still does. Only where a kind has no restore seam does it fall
//            back to recreating a copy, and then it says so.
//   action → recorded, NOT undoable (arbitrary side effects: print, adjust…)
//
// Each change has its own id — that id is what an undo names — and each one
// carries the hash of what it produced, so "put this change back" can be
// checked rather than hoped: if the record no longer matches what this change
// left behind, something else has touched it since, and the revert says so.
// An undo is itself a ledger row (undo_of) — undoing an undo works.

import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { actionSaid } from "./action-summary.js";
import { getTool, fetchKinds, resolveUpdatePath, resolveDeletePath, type WorkspaceApi } from "@cobblr/workspace-tools";
import { platform, imageId } from "@cobblr/platform-contract";
import type { CoreAiDB } from "../db.js";

export interface WriteRequest {
  tool: "create" | "update" | "delete" | "action";
  entity_kind: string;
  entity_id?: string;
  fields?: Record<string, unknown>;
  action_id?: string;
  args?: Record<string, unknown>;
}

export interface BulkOutcome {
  ok: boolean;
  message: string;
  count: number;
  failed: string[];
  /** One per record that landed — a single Undo in the panel presses them all. */
  ledger_ids: string[];
  undoable: boolean;
}

export interface WriteOutcome {
  ok: boolean;
  message: string;
  /** Why an undo stopped short, when it did — so a caller can offer the person
   *  the one thing that would get past it, named. Absent on success. */
  held?: "yours-now" | "has-contents" | "deleted-since";
  /** What was held back, and what is in the way, for that offer's wording. */
  label?: string;
  detail?: string;
  entity?: { kind: string; id?: string };
  ledger_id?: string;
  undoable?: boolean;
}

interface RecordImage {
  title?: string;
  name?: string;
  fields?: Record<string, unknown>;
  [k: string]: unknown;
}

async function imageOf(wsApi: WorkspaceApi, kind: string, id: string): Promise<RecordImage | null> {
  const r = await getTool("get_record")!.execute(wsApi, { kind, id });
  return r.ok ? (r.data as RecordImage) : null;
}

/** The state to come back to: the whole row where the kind can give one, the
 *  resolved view where it cannot.
 *
 *  These are not interchangeable. A resolved record publishes the fields a kind
 *  chooses to; notes and descriptions are commonly not among them. An undo
 *  built on the view silently drops those columns — it does not restore them
 *  and does not even see them change. Whichever is stored, the ledger keeps the
 *  label separately, so display never depends on which one this was. */
async function stateOf(
  wsApi: WorkspaceApi,
  orgId: string | undefined,
  kind: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  if (orgId) {
    const row = await platform()
      .entities.snapshot(kind, orgId, id)
      .catch(() => null);
    if (row) return row;
  }
  const img = await imageOf(wsApi, kind, id);
  return img ? ((img.fields ?? img) as Record<string, unknown>) : null;
}

/** A stable fingerprint of a record's state.
 *
 *  Keys sorted so two equal states hash equally whatever order they arrive in.
 *  `updated_at` is deliberately INCLUDED: a touch by anything else is exactly
 *  what this is here to notice. */
export function stateHash(image: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => ((acc[k] = canon(o[k])), acc), {});
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canon(image) ?? null)).digest("hex").slice(0, 32);
}

function labelOfImage(img: RecordImage | null, fallback: string): string {
  return String(img?.title ?? img?.name ?? img?.fields?.title ?? img?.fields?.name ?? fallback);
}

/** Can this ledger row be undone? (Its own state + the kind's declared routes.) */
export function undoableOf(
  row: { tool: string; entity_kind: string; entity_id: string | null; undone_at: Date | null; before: unknown },
  kinds: Parameters<typeof resolveUpdatePath>[2],
): boolean {
  if (row.undone_at) return false;
  switch (row.tool) {
    case "create":
      return !!row.entity_id && resolveDeletePath(row.entity_kind, row.entity_id, kinds) !== null;
    case "update":
      return !!row.entity_id && !!row.before && resolveUpdatePath(row.entity_kind, row.entity_id, kinds) !== null;
    case "delete":
      return !!row.before; // recreate needs the image (create route re-checked at undo time)
    default:
      return false; // actions: side effects have no inverse
  }
}

/** Execute one write through the SHARED registry executors, capturing the
 *  before-image and recording the ledger row. The ONLY way chat writes run. */
/** One instruction, many records: "each rack should have Shelf 1 through 5".
 *
 *  Each record still goes through performWrite on its own — its own
 *  before-image, its own ledger row, its own undo — because that is what makes
 *  any of it reversible. What is shared is the REPORT: one sentence, and one
 *  set of handles the panel can offer as a single Undo.
 *
 *  Partial success is the normal case (a rack that already has two of the five
 *  shelves), so nothing is rolled back and nothing is hidden: the count that
 *  landed and the reasons the rest did not both come back. */
export async function performWrites(
  wsApi: WorkspaceApi,
  db: Kysely<CoreAiDB>,
  userId: string,
  reqs: WriteRequest[],
  opts: { auto: boolean; orgId?: string; prompt?: string; turnId?: string },
): Promise<BulkOutcome> {
  const results: WriteOutcome[] = [];
  for (const r of reqs) results.push(await performWrite(wsApi, db, userId, r, opts));
  const done = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  // One instruction can span kinds ("delete duplicates" cleans locations AND
  // parts), and "Removed 2 locations" is wrong when one of them was a part.
  const kinds = new Set(reqs.map((r) => r.entity_kind));
  const noun = kinds.size === 1 ? (reqs[0]?.entity_kind?.split(":").pop() ?? "record") : "thing";
  const plural = done.length === 1 ? noun : `${noun}s`;
  // "Added 2 locations" is a lie when the two were deleted. One instruction is
  // one KIND of change, so the verb comes from what it did.
  const verb =
    reqs[0]?.tool === "delete" ? "Removed" : reqs[0]?.tool === "update" ? "Updated" : "Added";
  // "2 were already there" is the whole of what a person needs from the common
  // partial: asking for shelves 1-5 where two exist. Matching on the error CODE
  // (which this repo owns) rather than the sentence, and only collapsing when
  // every failure is that one — a mixed bag still shows a real reason.
  const dupes = failed.filter((f) => f.message.includes("(duplicate_sibling)"));
  const allDupes = failed.length > 0 && dupes.length === failed.length;
  const message = !failed.length
    ? `${verb} ${done.length} ${plural}.`
    : allDupes
      ? `${verb} ${done.length} ${plural}. ${failed.length} ${failed.length === 1 ? "was" : "were"} already there.`
      : `${verb} ${done.length} ${plural}. ${failed.length} could not be: ${failed[0]!.message}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ""}`;
  return {
    ok: done.length > 0,
    message,
    count: done.length,
    failed: failed.map((f) => f.message),
    ledger_ids: done.map((d) => d.ledger_id).filter((id): id is string => !!id),
    undoable: done.every((d) => d.undoable !== false),
  };
}

export async function performWrite(
  wsApi: WorkspaceApi,
  db: Kysely<CoreAiDB>,
  userId: string,
  req: WriteRequest,
  opts: {
    auto: boolean;
    /** Which workspace — needed to reach the kind's snapshot/restore seam.
     *  Without it a write still happens, it just cannot store the whole row,
     *  and the undo falls back to the resolved view. */
    orgId?: string;
    undoOf?: string;
    /** The message that asked for this, and the turn it belongs to. Recorded so
     *  a successful write and the sentence that caused it are one example, not
     *  two unrelated rows. Absent for an undo or a non-chat caller. */
    prompt?: string;
    turnId?: string;
  },
): Promise<WriteOutcome> {
  const { tool, entity_kind } = req;

  if (tool === "action") {
    const r = await getTool("invoke_action")!.execute(wsApi, {
      action_id: req.action_id ?? "",
      entity_kind,
      entity_id: req.entity_id ?? "",
      args: req.args,
    });
    if (!r.ok) return { ok: false, message: r.error ?? "Action failed." };
    const row = await db
      .insertInto("core_ai_chat_writes")
      .values({
        user_id: userId,
        tool: "action",
        entity_kind,
        entity_id: req.entity_id ?? null,
        entity_label: req.action_id ?? "",
        before: null,
        payload: JSON.stringify({ action_id: req.action_id, args: req.args ?? null }) as unknown,
        auto_applied: opts.auto,
        prompt: opts.prompt ?? null,
        turn_id: opts.turnId ?? null,
        undone_at: null,
        undo_of: opts.undoOf ?? null,
      })
      .returning("id")
      .executeTakeFirst();
    // What the action itself said it did, rather than a tick with no sentence.
    return {
      ok: true,
      message: actionSaid((r.data as { result?: unknown } | undefined)?.result),
      ledger_id: row?.id,
      undoable: false,
    };
  }

  if (tool === "create") {
    const r = await getTool("create_record")!.execute(wsApi, { kind: entity_kind, fields: req.fields ?? {} });
    if (!r.ok) return { ok: false, message: r.error ?? "Create failed." };
    const created = r.data as { id?: string; name?: string; title?: string };
    const label = String(created.title ?? created.name ?? req.fields?.title ?? req.fields?.name ?? entity_kind);
    // Read the record back rather than trusting the create's echo: what the
    // row actually IS, defaults and derived columns included, is what a later
    // undo has to compare against.
    const after = created.id ? await stateOf(wsApi, opts.orgId, entity_kind, String(created.id)) : null;
    const row = await db
      .insertInto("core_ai_chat_writes")
      .values({
        user_id: userId,
        tool: "create",
        entity_kind,
        entity_id: created.id ? String(created.id) : null,
        entity_label: label,
        before: null,
        after: after ? (JSON.stringify(after) as unknown) : null,
        after_hash: after ? stateHash(after) : null,
        payload: JSON.stringify(req.fields ?? {}) as unknown,
        auto_applied: opts.auto,
        prompt: opts.prompt ?? null,
        turn_id: opts.turnId ?? null,
        undone_at: null,
        undo_of: opts.undoOf ?? null,
      })
      .returning("id")
      .executeTakeFirst();
    return {
      ok: true,
      message: `Created ${label}.`,
      entity: { kind: entity_kind, id: created.id ? String(created.id) : undefined },
      ledger_id: row?.id,
      undoable: !!created.id,
    };
  }

  // update / delete need the record's id + a before-image FIRST.
  const id = String(req.entity_id ?? "");
  if (!id) return { ok: false, message: "Missing record id." };
  const view = await imageOf(wsApi, entity_kind, id);
  if (!view) return { ok: false, message: "Couldn't read the record before changing it: nothing was done." };
  const label = labelOfImage(view, id);
  // The label comes from the view (it knows what a person calls this); the
  // STATE comes from the row.
  const before = ((await stateOf(wsApi, opts.orgId, entity_kind, id)) ?? view) as RecordImage;

  if (tool === "update") {
    const r = await getTool("update_record")!.execute(wsApi, { kind: entity_kind, id, fields: req.fields ?? {} });
    if (!r.ok) return { ok: false, message: r.error ?? "Update failed." };
    const after = await stateOf(wsApi, opts.orgId, entity_kind, id);
    const row = await db
      .insertInto("core_ai_chat_writes")
      .values({
        user_id: userId,
        tool: "update",
        entity_kind,
        entity_id: id,
        entity_label: label,
        before: JSON.stringify(before) as unknown,
        after: after ? (JSON.stringify(after) as unknown) : null,
        after_hash: after ? stateHash(after) : null,
        payload: JSON.stringify(req.fields ?? {}) as unknown,
        auto_applied: opts.auto,
        prompt: opts.prompt ?? null,
        turn_id: opts.turnId ?? null,
        undone_at: null,
        undo_of: opts.undoOf ?? null,
      })
      .returning("id")
      .executeTakeFirst();
    return { ok: true, message: "Updated.", entity: { kind: entity_kind, id }, ledger_id: row?.id, undoable: true };
  }

  // delete
  const r = await getTool("delete_record")!.execute(wsApi, { kind: entity_kind, id });
  if (!r.ok) return { ok: false, message: r.error ?? "Delete failed." };
  const row = await db
    .insertInto("core_ai_chat_writes")
    .values({
      user_id: userId,
      tool: "delete",
      entity_kind,
      entity_id: id,
      entity_label: label,
      before: JSON.stringify(before) as unknown,
      // There is no after-state to compare: the record is gone. A restore that
      // finds something back at that id learns it from the id being taken.
      after: null,
      after_hash: null,
      payload: null,
      auto_applied: opts.auto,
      undone_at: null,
      undo_of: opts.undoOf ?? null,
    })
    .returning("id")
    .executeTakeFirst();
  return { ok: true, message: `Deleted ${label}.`, entity: { kind: entity_kind, id }, ledger_id: row?.id, undoable: true };
}

/** Put a stored row back through the kind's own restore seam.
 *
 *  False means this kind has no seam yet, NOT that the undo failed — the caller
 *  falls back to a forward write and says which of the two it did, because
 *  "restored" and "made you a new one that looks the same" are different
 *  promises and only one of them keeps a child pointing at its parent. */
/** Which columns differ, ignoring the ones that move on their own.
 *
 *  `updated_at` changes on every touch including ones that changed nothing a
 *  person would recognise, so a difference there alone is not evidence anybody
 *  edited anything. */
function changedColumns(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const skip = new Set(["updated_at", "id"]);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (skip.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out;
}

/** The record's own columns, with the id put back on.
 *
 *  A resolved record wraps its columns in `fields` and carries the id beside
 *  them, so unwrapping loses exactly the one thing a restore is keyed by — and
 *  the restore then declines, quietly, and the caller recreates a copy instead.
 *  That is the whole difference between "your shelf is back" and "here is a new
 *  shelf that looks like it". */
function imageWithId(before: RecordImage, entityId: string | null): Record<string, unknown> {
  const cols = (before.fields ?? before) as Record<string, unknown>;
  const id = imageId(cols) ?? imageId(before as Record<string, unknown>) ?? entityId;
  return id ? { ...cols, id } : cols;
}

async function restoreState(
  orgId: string,
  kind: string,
  image: Record<string, unknown>,
): Promise<boolean> {
  if (!imageId(image)) return false;
  try {
    return await platform().entities.restore(kind, orgId, image);
  } catch {
    // A seam that exists and threw is a real failure; report it as "no restore"
    // so the caller falls back rather than telling the user it worked.
    return false;
  }
}

function parseJsonb<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === "object") return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return null;
  }
}

/** Revert one ledger row. The undo runs through performWrite itself, so it is
 *  ledgered too (undo_of) — undoing an undo works. */
export async function undoWrite(
  wsApi: WorkspaceApi,
  db: Kysely<CoreAiDB>,
  userId: string,
  writeId: string,
  orgId: string,
  /** Go through with the ones that were held back.
   *
   *  The guards below exist because an undo must not take back what a PERSON
   *  did after Cobb. That is a rule about what the software decides on its
   *  own, not a rule about what a person may ask for — so the same person, told
   *  exactly what is in the way, can say "yes, those too". Every forced step is
   *  a ledger row like any other, so this too can be undone. */
  force = false,
): Promise<WriteOutcome> {
  const row = await db
    .selectFrom("core_ai_chat_writes")
    .selectAll()
    .where("id", "=", writeId)
    .executeTakeFirst();
  if (!row) return { ok: false, message: "No such change." };
  if (row.undone_at) return { ok: false, message: "Already undone." };

  const before = parseJsonb<RecordImage>(row.before);
  const payload = parseJsonb<Record<string, unknown>>(row.payload);
  let outcome: WriteOutcome;

  // Is this change still the last word on that record?
  //
  // Undo means "take back what COBB did", and a person who edited the same
  // record afterwards has said something more recent than either of them. So
  // an undo never overwrites a value a person set after the change it is
  // undoing: it puts back the fields that are still as Cobb left them, leaves
  // the ones that are not, and names them.
  const after = parseJsonb<Record<string, unknown>>(row.after);
  const current = row.entity_id ? await stateOf(wsApi, orgId, row.entity_kind, row.entity_id) : null;
  const goneSince = !!row.entity_id && !!row.after_hash && current === null;
  const untouched = !!current && !!row.after_hash && stateHash(current) === row.after_hash;

  // You deleted it yourself. Putting it back is not undoing Cobb's change, it
  // is undoing YOURS — and nobody asked for that.
  if (goneSince && row.tool !== "create") {
    // Nothing to offer here: there is no version of "go through with it" that
    // does anything, short of resurrecting a record its owner deleted.
    return {
      ok: false,
      held: "deleted-since",
      message: `${row.entity_label} has been deleted since, so there is nothing to put back. Undoing that deletion is a separate step.`,
    };
  }

  switch (row.tool) {
    case "create": {
      if (!row.entity_id) return { ok: false, message: "This create can't be undone (no record id)." };
      // You have since made this record yours: put a note on it, filed
      // something in it, renamed it. Undoing the create would delete all of
      // that, which is not "take back what Cobb did" — it is taking back what
      // YOU did as well. So it stays, and says why.
      const yourEdits = current && after ? changedColumns(after, current) : [];
      if (yourEdits.length > 0 && !force) {
        return {
          ok: false,
          held: "yours-now",
          label: row.entity_label,
          detail: yourEdits.join(", "),
          message: `${row.entity_label} has been changed since Cobb made it (${yourEdits.join(", ")}), so it was left alone.`,
        };
      }
      // A delete is not local. This table cascades to children, so removing the
      // rack an untouched undo just spared a shelf inside would delete that
      // shelf anyway — one step later, and with nothing said. Whatever still
      // lives in it is checked before, not after.
      const wouldTake = await platform()
        .entities.dependents(row.entity_kind, orgId, row.entity_id)
        .catch(() => null);
      if (wouldTake && wouldTake.length > 0 && !force) {
        const names = wouldTake.slice(0, 3).join(", ");
        const more = wouldTake.length > 3 ? ` and ${wouldTake.length - 3} more` : "";
        return {
          ok: false,
          held: "has-contents",
          label: row.entity_label,
          detail: `${names}${more}`,
          message: `${row.entity_label} still has ${names}${more} in it, so it was left alone — removing it would have taken ${wouldTake.length === 1 ? "that" : "those"} with it.`,
        };
      }

      // Already gone — you deleted it yourself. The end state is the one the
      // undo was going to produce, so it is done, not failed.
      if (goneSince || current === null) {
        await db.updateTable("core_ai_chat_writes").set({ undone_at: new Date() }).where("id", "=", row.id).execute();
        return { ok: true, message: `${row.entity_label} was already gone.` };
      }
      outcome = await performWrite(
        wsApi,
        db,
        userId,
        { tool: "delete", entity_kind: row.entity_kind, entity_id: row.entity_id },
        { auto: false, orgId, undoOf: row.id },
      );
      break;
    }
    case "update": {
      if (!row.entity_id || !before) return { ok: false, message: "This update can't be undone (no before-image)." };
      // The WHOLE prior row goes back, not only the keys the write sent: a
      // write's side effects (a recomputed depth, a denormalised field, a
      // timestamp another rule keys off) are part of what it did, and leaving
      // them behind is how "undone" ends up meaning "mostly undone".
      // Nothing else has touched it: the whole row goes back, exactly.
      const restored = untouched && (await restoreState(orgId, row.entity_kind, imageWithId(before, row.entity_id)));
      if (restored) {
        outcome = { ok: true, message: `Put ${row.entity_label} back.`, entity: { kind: row.entity_kind, id: row.entity_id } };
      } else if (current && after) {
        // Something did. Put back only what is still as Cobb left it.
        const beforeCols = imageWithId(before, row.entity_id);
        const revert: Record<string, unknown> = {};
        const yours: string[] = [];
        for (const k of Object.keys(after)) {
          if (k === "id" || k === "updated_at") continue;
          const cobbChangedIt = JSON.stringify(after[k]) !== JSON.stringify(beforeCols[k]);
          if (!cobbChangedIt) continue;
          if (JSON.stringify(current[k]) === JSON.stringify(after[k])) revert[k] = beforeCols[k] ?? null;
          else yours.push(k);
        }
        if (Object.keys(revert).length === 0 && !force) {
          outcome = {
            ok: false,
            held: "yours-now",
            label: row.entity_label,
            detail: yours.join(" and ") || "it",
            message: `Nothing to put back on ${row.entity_label}: you have changed ${yours.join(" and ") || "it"} since, and that is more recent than what Cobb did.`,
          };
        } else if (force && yours.length) {
          // Asked for explicitly: Cobb's whole prior row goes back, including
          // over the fields a person changed afterwards. Ledgered, so pressing
          // undo on THIS puts their version back.
          const ok = await restoreState(orgId, row.entity_kind, imageWithId(before, row.entity_id));
          outcome = ok
            ? { ok: true, message: `Put ${row.entity_label} back, including the ${yours.join(" and ")} you had changed.` }
            : { ok: false, message: `Couldn't put ${row.entity_label} back.` };
        } else {
          const merged = { ...current, ...revert };
          const ok = await restoreState(orgId, row.entity_kind, imageWithId(merged as RecordImage, row.entity_id));
          if (!ok) {
            outcome = await performWrite(
              wsApi,
              db,
              userId,
              { tool: "update", entity_kind: row.entity_kind, entity_id: row.entity_id, fields: revert },
              { auto: false, orgId, undoOf: row.id },
            );
          } else {
            outcome = { ok: true, message: `Put ${row.entity_label} back.`, entity: { kind: row.entity_kind, id: row.entity_id } };
          }
          if (outcome.ok && yours.length) {
            outcome.message += ` Left the ${yours.join(" and ")} as you set ${yours.length > 1 ? "them" : "it"}.`;
          }
        }
      } else {
        // No restore seam for this kind: the honest fallback is the old
        // behaviour, and it only claims what it did.
        const changedKeys = Object.keys(payload ?? {});
        const fields: Record<string, unknown> = {};
        for (const k of changedKeys) fields[k] = (before.fields ?? before)[k] ?? null;
        outcome = await performWrite(
          wsApi,
          db,
          userId,
          { tool: "update", entity_kind: row.entity_kind, entity_id: row.entity_id, fields },
          { auto: false, orgId, undoOf: row.id },
        );
        if (outcome.ok) outcome.message = `Put back the fields that were changed on ${row.entity_label}.`;
      }
      break;
    }
    case "delete": {
      if (!before) return { ok: false, message: "This delete can't be undone (no before-image)." };
      const image = imageWithId(before, row.entity_id);
      // The SAME row, with its own id — so every child location, every label
      // and every part that pointed at it is pointing at it again. A recreated
      // copy would leave all of them pointing at nothing.
      const restored = await restoreState(orgId, row.entity_kind, image);
      if (restored) {
        outcome = {
          ok: true,
          message: `Put ${row.entity_label} back.`,
          entity: { kind: row.entity_kind, id: row.entity_id ?? undefined },
        };
      } else {
        const kinds = await fetchKinds(wsApi).catch(() => []);
        const declared = new Set((kinds.find((k) => k.id === row.entity_kind)?.fields ?? []).map((f) => f.name));
        const fields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(image)) {
          if ((declared.size === 0 || declared.has(k)) && v !== undefined && v !== null && k !== "id") fields[k] = v;
        }
        outcome = await performWrite(
          wsApi,
          db,
          userId,
          { tool: "create", entity_kind: row.entity_kind, fields },
          { auto: false, orgId, undoOf: row.id },
        );
        if (outcome.ok) outcome.message = `Recreated ${row.entity_label} (as a new record — this kind can't restore the original).`;
      }
      break;
    }
    default:
      return { ok: false, message: "Actions can't be undone: they have real-world side effects." };
  }

  if (outcome.ok) {
    await db
      .updateTable("core_ai_chat_writes")
      .set({ undone_at: new Date() })
      .where("id", "=", row.id)
      .execute();
  }
  return outcome;
}

export { fetchKinds };
