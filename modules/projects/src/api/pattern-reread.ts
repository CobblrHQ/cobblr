// What a re-read of a pattern does with what it read (#5900): each read line
// has a key (a yarn or tool is its kind and its order within that kind; a
// notion is its name), and a requirement that survived the clear-out (the
// person corrected it, picked a yarn for it, listed or finished it) is never
// made again beside itself. A corrected one wins outright; one only picked
// or finished takes what it lacks from the read, never a value it holds.
// Pure, so the rule is tested without a database.

export interface Surviving {
  id: string;
  read_key: string | null;
  edited: boolean;
  [field: string]: unknown;
}

/** The keys a read's rows get, in the read's own order. */
export function readKeys(read: ReadonlyArray<{ kind: string; label?: string | null }>): string[] {
  const ordinal = new Map<string, number>();
  return read.map((r) => {
    if (r.kind === "notion") return `notion:${String(r.label ?? "").toLowerCase()}`;
    const i = ordinal.get(r.kind) ?? 0;
    ordinal.set(r.kind, i + 1);
    return `${r.kind}:${i}`;
  });
}

const NOT_FILLED = new Set(["read_key", "kind", "project_id", "source", "pattern_file_id", "position"]);

export function planReread<R extends { read_key: string }>(read: readonly R[], survivors: readonly Surviving[]): { insert: R[]; fill: Array<{ id: string; set: Record<string, unknown> }> } {
  const byKey = new Map(survivors.filter((s) => s.read_key).map((s) => [s.read_key as string, s]));
  const insert: R[] = [];
  const fill: Array<{ id: string; set: Record<string, unknown> }> = [];
  for (const r of read) {
    const had = byKey.get(r.read_key);
    if (!had) {
      insert.push(r);
      continue;
    }
    if (had.edited) continue;
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) if (!NOT_FILLED.has(k) && v != null && had[k] == null) set[k] = v;
    if (Object.keys(set).length) fill.push({ id: had.id, set });
  }
  return { insert, fill };
}
