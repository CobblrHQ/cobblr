// Move one field's values into another, on every record of a kind, undoably.
//
// Two things settle that way (#4518): two fields that mean one thing ("Store"
// and "Acquired from" on the same kind), where one is kept; and a seller noted
// beside where a thing came from ("eBay · detroitaxle") becoming a field of its
// own. Both are a person's yes, never automatic, and both must come back
// exactly as they were.
//
// A value is moved only into an EMPTY field: something already there was put
// there on purpose, and the moved value then stays where it was rather than be
// lost. Every record's before is kept, so the undo puts back each value it took
// and empties each one it wrote, and nothing else.
//
// Custom fields (and a choice field's `_note` clarifier) live in a record's
// metadata, merged key by key through the kind's writer so no other key is
// touched. A module's own column is written through the writer's update.

import { SYSTEM_VIEWER, platform } from "@cobblr/platform-contract";
import { listAll } from "./entities.js";

export interface FieldMove {
  id: string;
  /** What `from` held, and whether it was written into `to` (false when `to`
   *  already had a value and the moved one was left in place). */
  value: string | number;
  wrote: boolean;
}

const SCAN_CAP = 20_000;
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

async function write(orgId: string, kind: string, id: string, native: boolean, fields: Record<string, unknown>): Promise<void> {
  const writer = await platform().entities.getWriter(orgId, kind);
  if (!writer) throw new Error("this kind of record cannot be written from here");
  if (native) await writer.update(orgId, id, fields);
  else if (writer.mergeMetadata) await writer.mergeMetadata(orgId, id, fields);
  else await platform().entities.mergeMetadata(orgId, kind, id, fields);
}

/** Move `from` into `to` on every record of `kind` that holds a value in
 *  `from`. `nativeTo` says `to` is the module's own column. Returns each
 *  record's move, the undo's input. */
export async function moveFieldValues(orgId: string, kind: string, from: string, to: string, opts: { nativeTo?: boolean } = {}): Promise<FieldMove[]> {
  // SYSTEM-READ: moving a field's values covers every record of the kind, hidden fields included; the person who asked sees only the count.
  const { items } = await listAll(orgId, kind, { include_retired: true }, SYSTEM_VIEWER, { cap: SCAN_CAP });
  const moves: FieldMove[] = [];
  for (const it of items) {
    const f = (it.fields ?? {}) as Record<string, unknown>;
    const meta = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
    const v = meta[from];
    if (blank(v) || (typeof v !== "string" && typeof v !== "number")) continue;
    const there = opts.nativeTo ? f[to] : meta[to];
    const wrote = blank(there);
    if (wrote) await write(orgId, kind, it.id, !!opts.nativeTo, { [to]: v });
    if (wrote) await write(orgId, kind, it.id, false, { [from]: null });
    moves.push({ id: it.id, value: v, wrote });
  }
  return moves;
}

/** Put each moved value back in `from` and empty `to` where this wrote it,
 *  only while `to` still holds the value it wrote (a correction made since is
 *  kept). */
export async function unmoveFieldValues(orgId: string, kind: string, from: string, to: string, moves: readonly FieldMove[], opts: { nativeTo?: boolean } = {}): Promise<number> {
  let back = 0;
  for (const m of moves) {
    if (!m.wrote) continue;
    // SYSTEM-READ: the undo checks each record it wrote, hidden fields included, so a correction made since is kept.
    const rec = await platform().entities.lookup(orgId, kind, m.id, SYSTEM_VIEWER);
    const f = (rec?.fields ?? {}) as Record<string, unknown>;
    const meta = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
    const now = opts.nativeTo ? f[to] : meta[to];
    if (String(now ?? "") !== String(m.value)) continue;
    await write(orgId, kind, m.id, false, { [from]: m.value });
    await write(orgId, kind, m.id, !!opts.nativeTo, { [to]: null });
    back++;
  }
  return back;
}
