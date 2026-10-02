// A thing is no longer yours: sold, given away, parted out, lost, thrown out.
// And the way back, when it comes home again.
//
// One door for every kind. The module records it the way its kind means "out
// of use" (EntityWriter.retire: a part's archive flag, an asset put away, a
// machine's lifecycle state), which is what takes it out of the lists and the
// totals; the kernel writes how it left into the record's own metadata
// (DISPOSITION_KEY), so one banner, one search and one sentence read every
// kind the same. History keeps it: the record is never deleted.

import { platform } from "@cobblr/platform-contract";
import {
  DISPOSITION_KEY,
  readRecordDisposition,
  sayDisposition,
  type Disposition,
  type RecordDisposition,
} from "@cobblr/platform-contract/disposition";
import * as activity from "./activity.js";
import { baseKindOf, lookup } from "./entities.js";

export interface GoneDetails {
  how: Disposition;
  on?: string | null;
  price?: number | null;
  to?: string | null;
  note?: string | null;
}

export interface GoneOutcome {
  id: string;
  title: string;
  /** What it was before this call, so an undo can put exactly that back. */
  before: RecordDisposition | null;
}

const actionFor = (how: Disposition) => `record_${how.replace(/-/g, "_")}`;
export const BROUGHT_BACK = "record_brought_back";

/** When it became the person's: the kind's acquired-on field, if it has one
 *  and the record holds a day there. */
async function heldSince(orgId: string, kind: string, fields: Record<string, unknown>): Promise<string | null> {
  const roled = await platform().entities.roledFieldsFor(orgId, kind).catch(() => []);
  const f = roled.find((r) => r.field_role === "acquired-on");
  if (!f) return null;
  const meta = (fields.metadata && typeof fields.metadata === "object" ? fields.metadata : {}) as Record<string, unknown>;
  const v = f.native ? fields[f.name] : meta[f.name];
  const s = v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

async function refOf(orgId: string, kind: string, id: string) {
  const [module, type] = (await baseKindOf(orgId, kind)).split(":");
  return { module: module ?? null, entityType: type ?? kind, entityId: id };
}

/** Mark these records as no longer the person's. Refuses the whole call,
 *  before writing anything, when the kind cannot (no `retire`) or a record is
 *  missing: half a batch marked sold is worse than none. */
export async function markGone(
  orgId: string,
  userId: string | null,
  kind: string,
  ids: readonly string[],
  details: GoneDetails,
): Promise<{ ok: true; done: GoneOutcome[] } | { ok: false; error: string }> {
  const writer = await platform().entities.getWriter(orgId, kind);
  if (!writer?.retire || !writer.unretire) {
    return { ok: false, error: `${kind} records cannot be marked as sold or given away.` };
  }
  const found = [];
  for (const id of ids) {
    const ent = await lookup(orgId, kind, id);
    if (!ent) return { ok: false, error: `no ${kind} record with id ${id}` };
    found.push(ent);
  }
  const done: GoneOutcome[] = [];
  for (const ent of found) {
    const fields = (ent.fields ?? {}) as Record<string, unknown>;
    const before = readRecordDisposition(fields.metadata);
    const d: RecordDisposition = {
      how: details.how,
      on: details.on?.slice(0, 10) || (await platform().accounts.dayFor(userId)),
      price: typeof details.price === "number" && Number.isFinite(details.price) ? details.price : null,
      to: details.to?.trim() || null,
      note: details.note?.trim() || null,
      held_since: before?.held_since ?? (await heldSince(orgId, kind, fields)),
    };
    await writer.retire(orgId, ent.id, { disposition: d.how });
    await platform().entities.mergeMetadata(orgId, kind, ent.id, { [DISPOSITION_KEY]: d });
    await activity.log({
      orgId,
      userId,
      action: actionFor(d.how),
      ref: await refOf(orgId, kind, ent.id),
      diff: { name: ent.title, said: sayDisposition(d), ...d },
    });
    done.push({ id: ent.id, title: ent.title, before });
  }
  return { ok: true, done };
}

/** It is the person's again: back in the lists and the totals. */
export async function bringBack(
  orgId: string,
  userId: string | null,
  kind: string,
  ids: readonly string[],
): Promise<{ ok: true; done: GoneOutcome[] } | { ok: false; error: string }> {
  const writer = await platform().entities.getWriter(orgId, kind);
  if (!writer?.unretire) return { ok: false, error: `${kind} records cannot be brought back.` };
  const found = [];
  for (const id of ids) {
    const ent = await lookup(orgId, kind, id);
    if (!ent) return { ok: false, error: `no ${kind} record with id ${id}` };
    found.push(ent);
  }
  const done: GoneOutcome[] = [];
  for (const ent of found) {
    const before = readRecordDisposition(((ent.fields ?? {}) as Record<string, unknown>).metadata);
    await writer.unretire(orgId, ent.id);
    await platform().entities.mergeMetadata(orgId, kind, ent.id, { [DISPOSITION_KEY]: null });
    await activity.log({
      orgId,
      userId,
      action: BROUGHT_BACK,
      ref: await refOf(orgId, kind, ent.id),
      diff: { name: ent.title, ...(before ? { was: sayDisposition(before) } : {}) },
    });
    done.push({ id: ent.id, title: ent.title, before });
  }
  return { ok: true, done };
}
