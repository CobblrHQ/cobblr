// The values a field already holds across a kind's records, for the choice
// picker's list: how many records hold each, and when one last took it. A
// field's list is its choices AND everything already used, so a workspace's
// own data seeds the picker with no migration (a "Facebook Marketplace" typed
// last year is offered today). With `detail`, each value also carries the
// details used with it (the sellers seen under eBay), for the picker's
// right-hand column: the field's `<name>_note` clarifier, or a field of its
// own when the kind has one.
//
// Read as the person asking (their read scopes apply), and bounded: a choice
// vocabulary is small, so a scan of the newest records answers it.

import { fieldNoteKey, type EntityViewer } from "@cobblr/platform-contract";
import { listAll as listAllEntities } from "./entities.js";

const SCAN = 2000;

export interface UsedValue {
  value: string;
  uses: number;
  lastUsed: string | null;
}

export interface FieldValuesUsed {
  values: UsedValue[];
  /** By value (lower-cased, spaces collapsed): the details used with it. */
  details?: Record<string, UsedValue[]>;
}

const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

function bump(map: Map<string, UsedValue>, raw: unknown, at: string | null): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const v = raw.trim().replace(/\s+/g, " ");
  const k = key(v);
  const cur = map.get(k);
  if (!cur) map.set(k, { value: v, uses: 1, lastUsed: at });
  else {
    cur.uses += 1;
    if (at && (!cur.lastUsed || at > cur.lastUsed)) cur.lastUsed = at;
  }
  return k;
}

/** `detail`: the key of the field whose values ride beside this one's (the
 *  clarifier `<field>_note` when omitted and `withNote` is set). */
export async function fieldValuesUsed(
  orgId: string,
  kind: string,
  field: string,
  opts: { detail?: string | null; withNote?: boolean; viewer?: EntityViewer } = {},
): Promise<FieldValuesUsed> {
  const detailKey = opts.detail || (opts.withNote ? fieldNoteKey(field) : null);
  const { items } = await listAllEntities(orgId, kind, { include_retired: true }, opts.viewer, { cap: SCAN });
  const values = new Map<string, UsedValue>();
  const details = new Map<string, Map<string, UsedValue>>();
  for (const it of items) {
    const f = it.fields as Record<string, unknown>;
    const meta = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
    const read = (k: string) => (k in f ? f[k] : meta[k]);
    const at = typeof f.updated_at === "string" ? f.updated_at : f.updated_at instanceof Date ? f.updated_at.toISOString() : typeof f.created_at === "string" ? f.created_at : null;
    const k = bump(values, read(field), at);
    if (k && detailKey) {
      let m = details.get(k);
      if (!m) details.set(k, (m = new Map()));
      bump(m, read(detailKey), at);
    }
  }
  const out: FieldValuesUsed = { values: [...values.values()] };
  if (detailKey) out.details = Object.fromEntries([...details].map(([k, m]) => [k, [...m.values()]]));
  return out;
}
