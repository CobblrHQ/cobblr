// Undo and redo for the floor-plan editor.
//
// A plan is edited by hand, a drag at a time, and one wrong drop used to be
// permanent: there was no way back except dragging it again from memory
// (#4190). Every edit the editor makes is recorded here as a step: what each
// record looked like before and after. Undo writes the before back, redo the
// after, through the same endpoints the edit itself used. A place the editor
// ADDED is undone by deleting it, and redone through the place restore
// (#4189), so it comes back under the same id rather than as a copy.
//
// One history per workspace, shared by every plan on screen, so a drawer
// moved inside a peek and a rack moved on the room behind it undo in the
// order they happened.

import { jsonbPatchBetween } from "@cobblr/platform-contract/jsonb-merge";
import { editOf, type Edit } from "@cobblr/platform-web";
import { api, type Location } from "./api";

/** One record's state on either side of a step. */
export type PlanChange =
  | {
      kind: "place";
      id: string;
      before: Partial<Pick<Location, "metadata" | "parent_id" | "name">>;
      after: Partial<Pick<Location, "metadata" | "parent_id" | "name">>;
    }
  | {
      kind: "record";
      /** Where the record's update goes: the kind's declared endpoint. */
      path: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }
  | { kind: "added"; id: string };

export interface PlanStep {
  /** What happened, in words: "Moved Rack 2". */
  label: string;
  changes: PlanChange[];
}

export interface PlanWriter {
  updatePlace(id: string, edit: Edit<Location>): Promise<unknown>;
  updateRecord(path: string, edit: Edit<Record<string, unknown>>): Promise<unknown>;
  deletePlace(id: string): Promise<unknown>;
  restorePlace(id: string): Promise<unknown>;
}

const LIMIT = 50;

/** The write that turns one side of a change into the other. The server
 *  MERGES metadata (a key left out is kept, only a null removes it), so
 *  sending the old bag whole would leave every key the edit added: undoing a
 *  first placement would leave the rect on the plan and say "Undone". The
 *  metadata goes as the difference from the side it is leaving. */
function patchFrom(
  c: { before: Record<string, unknown>; after: Record<string, unknown> },
  side: "before" | "after",
): Record<string, unknown> {
  const other = side === "before" ? c.after : c.before;
  const body = { ...c[side] };
  if ("metadata" in body) {
    body.metadata = jsonbPatchBetween(other.metadata as Record<string, unknown> | null | undefined, (body.metadata ?? {}) as Record<string, unknown>);
  }
  return body;
}

export interface PlanHistory {
  record(step: PlanStep): void;
  /** Undo the newest step. Resolves to it, or null when there is none. */
  undo(): Promise<PlanStep | null>;
  redo(): Promise<PlanStep | null>;
  canUndo(): boolean;
  canRedo(): boolean;
  /** The step Undo would take back, for its button's title. */
  nextUndo(): PlanStep | null;
  nextRedo(): PlanStep | null;
  subscribe(fn: () => void): () => void;
}

export function createPlanHistory(writer: PlanWriter): PlanHistory {
  const past: PlanStep[] = [];
  const future: PlanStep[] = [];
  const listeners = new Set<() => void>();
  // One at a time: two fast presses must not apply the same step twice, or
  // interleave two steps' writes.
  let running: Promise<unknown> = Promise.resolve();
  const notify = () => listeners.forEach((fn) => fn());

  async function apply(step: PlanStep, side: "before" | "after") {
    // Undo walks the changes backwards, so a step that added a place and then
    // moved another puts them back in the reverse of how they happened.
    const order = side === "before" ? [...step.changes].reverse() : step.changes;
    for (const c of order) {
      // Judged against the side it is leaving: a place someone moved since is
      // not put back over their move (#7925).
      const was = side === "before" ? "after" : "before";
      if (c.kind === "place") await writer.updatePlace(c.id, editOf(c[was], patchFrom(c, side) as Partial<Location>));
      else if (c.kind === "record") await writer.updateRecord(c.path, editOf(c[was], patchFrom(c, side)));
      else if (side === "before") await writer.deletePlace(c.id);
      else await writer.restorePlace(c.id);
    }
  }

  function move(from: PlanStep[], to: PlanStep[], side: "before" | "after"): Promise<PlanStep | null> {
    const next = running.then(async () => {
      const step = from[from.length - 1];
      if (!step) return null;
      await apply(step, side);
      from.pop();
      to.push(step);
      notify();
      return step;
    });
    running = next.catch(() => undefined);
    return next;
  }

  return {
    record(step) {
      if (step.changes.length === 0) return;
      past.push(step);
      if (past.length > LIMIT) past.shift();
      // A new edit after an undo is a new branch: what was undone is gone.
      future.length = 0;
      notify();
    },
    undo: () => move(past, future, "before"),
    redo: () => move(future, past, "after"),
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    nextUndo: () => past[past.length - 1] ?? null,
    nextRedo: () => future[future.length - 1] ?? null,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** What changed between two reads of the places list, as a step's changes:
 *  a place that is new was added, and a place whose layout, name or parent
 *  moved is put back to how it was. For an edit made on the server in one go
 *  (drafting a plan from a description), where the client never saw each
 *  write. A place that disappeared is not undone here: nothing on the plan
 *  deletes places. */
export function diffPlaces(
  before: ReadonlyArray<Pick<Location, "id" | "metadata" | "parent_id" | "name">>,
  after: ReadonlyArray<Pick<Location, "id" | "metadata" | "parent_id" | "name">>,
): PlanChange[] {
  const was = new Map(before.map((l) => [l.id, l]));
  const out: PlanChange[] = [];
  for (const l of after) {
    const b = was.get(l.id);
    if (!b) {
      out.push({ kind: "added", id: l.id });
      continue;
    }
    const from: Partial<Pick<Location, "metadata" | "parent_id" | "name">> = {};
    const to: Partial<Pick<Location, "metadata" | "parent_id" | "name">> = {};
    if (JSON.stringify(b.metadata ?? {}) !== JSON.stringify(l.metadata ?? {})) {
      from.metadata = b.metadata;
      to.metadata = l.metadata;
    }
    if (b.parent_id !== l.parent_id) {
      from.parent_id = b.parent_id;
      to.parent_id = l.parent_id;
    }
    if (b.name !== l.name) {
      from.name = b.name;
      to.name = l.name;
    }
    if (Object.keys(to).length) out.push({ kind: "place", id: l.id, before: from, after: to });
  }
  return out;
}

const bySlug = new Map<string, PlanHistory>();

/** The workspace's history, over the real endpoints. */
export function planHistoryFor(slug: string): PlanHistory {
  let h = bySlug.get(slug);
  if (!h) {
    h = createPlanHistory({
      updatePlace: (id, edit) => api.updateLocation(slug, id, edit),
      updateRecord: (path, edit) => api.request("PATCH", path, edit.body, edit.headers),
      deletePlace: (id) => api.deleteLocation(slug, id),
      restorePlace: (id) => api.restoreDeletedLocation(slug, id),
    });
    bySlug.set(slug, h);
  }
  return h;
}

/** Is this key press Undo or Redo? ⌘Z / Ctrl+Z undoes; ⌘⇧Z, Ctrl+Shift+Z and
 *  Ctrl+Y redo. A press while typing in a field is the field's own undo. */
export function historyKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "target">): "undo" | "redo" | null {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && e.ctrlKey && !e.metaKey) return "redo";
  return null;
}
