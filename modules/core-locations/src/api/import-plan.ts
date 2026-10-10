import { countOf } from "@cobblr/platform-contract/plural";
// The plan an import follows: which row creates, which updates, and under
// which parent, decided once and used by both the preview and the commit.
//
// The import used to decide twice. The preview marked a parent "resolved" if
// any row or place had that name; the commit then linked parents through a
// name -> id map where the second "Shelf 1" overwrote the first. A file with
// a Shelf 1 in the Attic and another in the Basement previewed as right and
// committed the Attic's shelf to the top level, with a Box A put in whichever
// shelf came last (#4115 audit). Now one planner answers both, and a name that
// names more than one place is refused with the path that would say which.
//
// A place can be written as its path, outermost first: "Attic › Shelf 1" (the
// app's own separator) or "Attic > Shelf 1", in the parent column or in the
// name column. A path is how two places with one name are told apart.

export const PATH_SEPARATOR = " › ";

/** Split a written place into its path, outermost first. */
export function pathSegments(written: string): string[] {
  return written
    .split(/\s*[›>]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const keyOf = (segs: string[]) => segs.map((s) => s.toLowerCase()).join("\u0000");

export interface ImportRow {
  row_number: number;
  name: string;
  short_name: string | null;
  kind: "area" | "container";
  parent_key: string | null;
  match_value: string | null;
  metadata: Record<string, string>;
}

export interface ExistingPlace {
  id: string;
  name: string;
  parent_id: string | null;
  metadata: Record<string, unknown> | null;
}

/** Where a row's parent is: an existing place, an earlier row of this file, or
 *  the top level. */
export type ParentRef = { existing: string } | { row: number } | null;

export interface PlannedRow {
  row_number: number;
  /** The place's own name: the last segment when the name was written as a path. */
  name: string;
  short_name: string | null;
  kind: "area" | "container";
  match_value: string | null;
  metadata: Record<string, string>;
  action: "create" | "update";
  /** The existing place an update writes to. */
  id: string | null;
  parent: { key: string; resolved: boolean; path: string | null } | null;
  parentRef: ParentRef;
  /** The row's full path once its parent is known. */
  path: string | null;
  /** Why this row cannot be imported as written; the commit refuses the file. */
  error: string | null;
}

export interface ImportPlan {
  rows: PlannedRow[];
  /** Rows in an order where every parent comes before its children. */
  order: number[];
  blocking: Array<{ row_number: number; message: string }>;
}

/** Plan an import by place name (paths allowed), the default match. */
export function planByName(rows: ImportRow[], existing: ExistingPlace[]): ImportPlan {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const existingPath = (id: string): string[] => {
    const segs: string[] = [];
    const seen = new Set<string>();
    for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
      seen.add(cur.id);
      segs.unshift(cur.name);
    }
    return segs;
  };
  const existingByPath = new Map<string, string>();
  const existingByName = new Map<string, string[]>();
  for (const e of existing) {
    existingByPath.set(keyOf(existingPath(e.id)), e.id);
    const k = e.name.toLowerCase();
    existingByName.set(k, [...(existingByName.get(k) ?? []), e.id]);
  }

  // Each row: its own name, and where its parent is written (the parent
  // column, else the path prefix of a name written as a path).
  const drafts = rows.map((r) => {
    const own = pathSegments(r.name);
    const name = own[own.length - 1] ?? r.name.trim();
    const parentSegs = r.parent_key ? pathSegments(r.parent_key) : own.slice(0, -1);
    return { r, name, parentSegs, path: null as string[] | null, parentRef: undefined as ParentRef | undefined, error: null as string | null };
  });
  const rowsNamed = new Map<string, number[]>();
  drafts.forEach((d, i) => {
    const k = d.name.toLowerCase();
    rowsNamed.set(k, [...(rowsNamed.get(k) ?? []), i]);
  });

  const describe = (i: number) => (drafts[i]!.path ? drafts[i]!.path!.join(PATH_SEPARATOR) : `row ${drafts[i]!.r.row_number}`);

  // Resolve parents until nothing more resolves: a parent defined later in the
  // file resolves once its own parent has.
  for (let progress = true; progress; ) {
    progress = false;
    drafts.forEach((d, i) => {
      if (d.parentRef !== undefined || d.error) return;
      if (d.parentSegs.length === 0) {
        d.parentRef = null;
        d.path = [d.name];
        progress = true;
        return;
      }
      const wanted = keyOf(d.parentSegs);
      if (d.parentSegs.length > 1) {
        // A path: a row of this file with that path, else an existing place.
        const row = drafts.findIndex((o, j) => j !== i && o.path && keyOf(o.path) === wanted);
        if (row >= 0) {
          d.parentRef = { row: row };
        } else if (existingByPath.has(wanted)) {
          d.parentRef = { existing: existingByPath.get(wanted)! };
        } else {
          // Not known yet; it may be a row whose own parent resolves later.
          const pending = drafts.some((o, j) => j !== i && !o.path && !o.error && o.name.toLowerCase() === d.parentSegs[d.parentSegs.length - 1]!.toLowerCase());
          if (pending) return;
          d.parentRef = undefined;
          d.error = `its parent "${d.parentSegs.join(PATH_SEPARATOR)}" is not a place, here or in the file`;
          progress = true;
          return;
        }
      } else {
        // A bare name: every row and every existing place with that name.
        const name = wanted;
        const rowsHere = (rowsNamed.get(name) ?? []).filter((j) => j !== i);
        const existingHere = (existingByName.get(name) ?? []).filter(
          // An existing place a row of this file will update is that row, not a second place.
          (id) => !rowsHere.some((j) => drafts[j]!.path && existingByPath.get(keyOf(drafts[j]!.path!)) === id),
        );
        const count = rowsHere.length + existingHere.length;
        if (count === 0) {
          d.error = `its parent "${d.parentSegs[0]}" is not a place, here or in the file`;
          progress = true;
          return;
        }
        if (count > 1) {
          if (rowsHere.some((j) => !drafts[j]!.path && !drafts[j]!.error)) return; // wait until their paths are known
          const options = [...rowsHere.map(describe), ...existingHere.map((id) => existingPath(id).join(PATH_SEPARATOR))];
          d.error = `${countOf(count, "place")} are called "${d.parentSegs[0]}": write the parent as its path, one of ${options.map((o) => `"${o}"`).join(", ")}`;
          progress = true;
          return;
        }
        d.parentRef = rowsHere.length ? { row: rowsHere[0]! } : { existing: existingHere[0]! };
      }
      const ref = d.parentRef!;
      const parentPath = "row" in ref ? drafts[ref.row]!.path : existingPath(ref.existing);
      if (!parentPath) {
        d.parentRef = undefined;
        return;
      }
      d.path = [...parentPath, d.name];
      progress = true;
    });
  }
  for (const d of drafts) {
    if (d.parentRef === undefined && !d.error) d.error = "its parent is inside a loop of rows that name each other";
  }

  // Two rows with one path are one place written twice.
  const seenPath = new Map<string, number>();
  drafts.forEach((d) => {
    if (!d.path || d.error) return;
    const k = keyOf(d.path);
    const first = seenPath.get(k);
    if (first !== undefined) d.error = `it repeats row ${first}, "${d.path.join(PATH_SEPARATOR)}"`;
    else seenPath.set(k, d.r.row_number);
  });

  // A row whose parent row cannot be imported cannot be either.
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of drafts) {
      if (d.error || !d.parentRef || !("row" in d.parentRef)) continue;
      const p = drafts[d.parentRef.row]!;
      if (p.error) {
        d.error = `its parent, row ${p.r.row_number}, cannot be imported`;
        changed = true;
      }
    }
  }

  const planned: PlannedRow[] = drafts.map((d) => {
    const exact = d.path ? existingByPath.get(keyOf(d.path)) : undefined;
    // Not at that path yet, but the only place with this name: the row moves it,
    // as a re-import that changes a parent always has.
    const onlyByName = !exact && !d.error ? existingByName.get(d.name.toLowerCase()) : undefined;
    const moves = onlyByName?.length === 1 && (rowsNamed.get(d.name.toLowerCase())?.length ?? 0) === 1 ? onlyByName[0] : undefined;
    const id = exact ?? moves ?? null;
    const parentWritten = d.parentSegs.length ? d.parentSegs.join(PATH_SEPARATOR) : null;
    return {
      row_number: d.r.row_number,
      name: d.name,
      short_name: d.r.short_name,
      kind: d.r.kind,
      match_value: d.r.match_value,
      metadata: d.r.metadata,
      action: id ? "update" : "create",
      id,
      parent: parentWritten
        ? { key: parentWritten, resolved: !!d.parentRef, path: d.path && d.path.length > 1 ? d.path.slice(0, -1).join(PATH_SEPARATOR) : null }
        : null,
      parentRef: d.parentRef ?? null,
      path: d.path ? d.path.join(PATH_SEPARATOR) : null,
      error: d.error,
    };
  });

  return finish(planned, drafts.map((d) => d.parentRef ?? null));
}

/** Plan an import matched on the person's own key column (an external id). */
export function planByKey(rows: ImportRow[], existing: ExistingPlace[], matchOn: string): ImportPlan {
  const existingByKey = new Map<string, string>();
  for (const e of existing) {
    const v = e.metadata?.[matchOn];
    if (v != null && v !== "") existingByKey.set(String(v).toLowerCase(), e.id);
  }
  const rowByKey = new Map<string, number>();
  const planned: PlannedRow[] = rows.map((r, i) => {
    const k = r.match_value?.toLowerCase() ?? null;
    let error: string | null = null;
    if (k) {
      const first = rowByKey.get(k);
      if (first !== undefined) error = `it repeats ${matchOn} "${r.match_value}" from row ${rows[first]!.row_number}`;
      else rowByKey.set(k, i);
    }
    const id = k ? existingByKey.get(k) ?? null : null;
    return {
      row_number: r.row_number, name: r.name, short_name: r.short_name, kind: r.kind, match_value: r.match_value, metadata: r.metadata,
      action: id ? "update" : "create", id, parent: null, parentRef: null, path: null, error,
    };
  });
  const refs: ParentRef[] = rows.map((r, i) => {
    if (!r.parent_key) return null;
    const pk = r.parent_key.toLowerCase();
    const row = rowByKey.get(pk);
    const ref: ParentRef = row !== undefined && row !== i ? { row } : existingByKey.has(pk) ? { existing: existingByKey.get(pk)! } : null;
    planned[i]!.parent = { key: r.parent_key, resolved: !!ref, path: null };
    if (!ref) planned[i]!.error ??= `its parent ${matchOn} "${r.parent_key}" is not a place, here or in the file`;
    return ref;
  });
  planned.forEach((p, i) => (p.parentRef = refs[i] ?? null));
  return finish(planned, refs);
}

/** Order parents before children, and gather what blocks the commit. */
function finish(planned: PlannedRow[], refs: ParentRef[]): ImportPlan {
  const order: number[] = [];
  const state = new Map<number, "doing" | "done">();
  const visit = (i: number) => {
    if (state.get(i) === "done") return;
    if (state.get(i) === "doing") {
      planned[i]!.error ??= "its parent is inside a loop of rows that name each other";
      return;
    }
    state.set(i, "doing");
    const ref = refs[i];
    if (ref && "row" in ref) visit(ref.row);
    state.set(i, "done");
    order.push(i);
  };
  planned.forEach((_, i) => visit(i));
  const blocking = planned.filter((p) => p.error).map((p) => ({ row_number: p.row_number, message: p.error! }));
  return { rows: planned, order, blocking };
}
