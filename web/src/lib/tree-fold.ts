// Folding and filtering for the locations tree.
//
// The tree used to render every node open, always. A workspace of rooms → racks
// → shelves is a thousand rows on one page with no way to make it shorter, and
// the page that is supposed to show you where things are becomes the one page
// you cannot find anything on.
//
// Two pure rules, one hook:
//
//   DEFAULT FOLD  Rooms are open; the containers inside them are closed. You
//                 see your rooms and the racks in them; a rack's shelves are one
//                 click away. Zones (an area inside an area) stay open because
//                 they are structure, not contents.
//   OVERRIDES     Every node you toggle is remembered, per workspace, so the
//                 tree you left is the tree you come back to.
//
// Filtering is the other half: type and the tree keeps only the nodes that
// match or contain a match, every surviving node open. Fold state is ignored
// while filtering and restored untouched when the box clears, so a search never
// wrecks the layout you arranged.

import { useCallback, useEffect, useMemo, useState } from "react";

export interface FoldableNode {
  id: string;
  name: string;
  short_name?: string | null;
  kind: string;
  children: FoldableNode[];
}

/** What the tree does with a node nobody has touched. */
export function defaultOpen(node: { kind: string }, depth: number): boolean {
  if (node.kind !== "container") return true;
  return depth === 0;
}

export type FoldOverrides = Record<string, boolean>;

export function isOpen(overrides: FoldOverrides, node: { id: string; kind: string }, depth: number): boolean {
  const o = overrides[node.id];
  return o === undefined ? defaultOpen(node, depth) : o;
}

/** Toggle one node. Flipping a node back to its default DROPS the override
 *  rather than storing a redundant one, so the stored set stays small and a
 *  later change to the default rule is not pinned by stale entries. */
export function toggleFold(overrides: FoldOverrides, node: { id: string; kind: string }, depth: number): FoldOverrides {
  const next = { ...overrides };
  const nowOpen = !isOpen(overrides, node, depth);
  if (nowOpen === defaultOpen(node, depth)) delete next[node.id];
  else next[node.id] = nowOpen;
  return next;
}

/** Everything open / everything to its default. "Collapse all" is "forget your
 *  overrides", not "close every node": rooms stay open because a page of seven
 *  closed room headers tells you nothing either. */
export function foldAll<T extends FoldableNode>(roots: T[], open: boolean): FoldOverrides {
  if (!open) return {};
  const out: FoldOverrides = {};
  const walk = (n: FoldableNode, depth: number) => {
    // A leaf has nothing to open; an override for it is noise.
    if (n.children.length > 0 && !defaultOpen(n, depth)) out[n.id] = true;
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const id of allRunIds(roots)) out[id] = true;
  return out;
}

/** Counts for a CLOSED node's summary chip: how much it hides. */
export function subtreeSize(node: FoldableNode): { nodes: number } {
  let nodes = 0;
  const walk = (n: FoldableNode) => {
    for (const c of n.children) {
      nodes++;
      walk(c);
    }
  };
  walk(node);
  return { nodes };
}

/** Prune the forest to nodes that match `q` or contain one. Case- and
 *  accent-insensitive on name and short name. An empty query returns the input
 *  untouched (same reference, so memoised callers do not re-render). */
export function filterForest<T extends FoldableNode>(roots: T[], q: string): T[] {
  const needle = norm(q);
  if (!needle) return roots;
  const prune = (n: T): T | null => {
    const kids = (n.children as T[]).map(prune).filter((c): c is T => c !== null);
    const self = norm(n.name).includes(needle) || norm(n.short_name ?? "").includes(needle);
    if (!self && kids.length === 0) return null;
    return { ...n, children: kids };
  };
  return roots.map(prune).filter((r): r is T => r !== null);
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Per-workspace fold memory. localStorage, because this is layout you
 *  arranged and a refresh should not undo it; keyed by slug, because the same
 *  browser sees more than one workspace. */
export function useFoldOverrides(slug: string): [FoldOverrides, (next: FoldOverrides) => void] {
  const key = `cobblr:locations-fold:${slug}`;
  const [state, setState] = useState<FoldOverrides>(() => read(key));
  useEffect(() => setState(read(key)), [key]);
  const set = useCallback(
    (next: FoldOverrides) => {
      setState(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // private mode / quota: the session still folds, it just forgets on reload
      }
    },
    [key],
  );
  return useMemo(() => [state, set], [state, set]);
}

function read(key: string): FoldOverrides {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as FoldOverrides) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Runs: "Rack 1 … Rack 7" as one row.
//
// A room with fifteen racks is fifteen rows that say the same thing fifteen
// times. When consecutive siblings share a word and count ("Rack 1", "Rack 2",
// …), the tree draws them as ONE row, "Rack 1 – 7 · 7 racks", closed, and opens
// to the individual cards. The range-create form is the inverse of this, so the
// data already carries the pattern; this just reads it back.
//
// A run is a DRAWING, not a location. It has no id in the database, takes no
// children of its own, and the member cards keep their own drag, select, edit
// and delete. Its only state is whether it is open, kept in the same override
// map as every other fold so Expand all / Collapse all reach it.

/** Fewer than this and a run saves nothing worth the extra click. */
export const MIN_RUN = 4;

export interface Run<T extends FoldableNode> {
  /** Stable across renders and reloads: the parent + the shared word. */
  id: string;
  /** The shared word as the first member writes it ("Rack"). */
  prefix: string;
  /** In display order, so a bottom-up shelf run still reads Shelf 5 first. */
  members: T[];
  lo: number;
  hi: number;
}

export type SiblingEntry<T extends FoldableNode> = { kind: "node"; node: T } | { kind: "run"; run: Run<T> };

const NUMBERED = /^(.*?)\s*(\d+)\s*$/;

function split(name: string): { prefix: string; n: number } | null {
  const m = name.trim().match(NUMBERED);
  if (!m) return null;
  const prefix = (m[1] ?? "").trim();
  if (!prefix) return null;
  return { prefix, n: Number(m[2]) };
}

/** Group one sibling list into plain nodes and runs, preserving order.
 *
 *  A run needs: the same word (case-insensitive), the same kind, numbers that
 *  keep moving the same way (up for Rack 1,2,3; down for a bottom-up Shelf
 *  5,4,3), and at least MIN_RUN members. Gaps are allowed ("Rack 1 – 7 ·
 *  6 racks" is honest about a missing one); a change of direction ends the
 *  run, because "Shelf 1, 2, 3, 2" is two things, not one. */
export function groupRuns<T extends FoldableNode>(siblings: readonly T[], parentId: string | null): SiblingEntry<T>[] {
  const out: SiblingEntry<T>[] = [];
  let i = 0;
  while (i < siblings.length) {
    const first = siblings[i]!;
    const head = split(first.name);
    if (!head) {
      out.push({ kind: "node", node: first });
      i++;
      continue;
    }
    const members: T[] = [first];
    let dir = 0;
    let prev = head.n;
    let j = i + 1;
    for (; j < siblings.length; j++) {
      const cand = siblings[j]!;
      const s = split(cand.name);
      if (!s || s.prefix.toLowerCase() !== head.prefix.toLowerCase() || cand.kind !== first.kind) break;
      const step = Math.sign(s.n - prev);
      if (step === 0) break;
      if (dir === 0) dir = step;
      else if (step !== dir) break;
      members.push(cand);
      prev = s.n;
    }
    // A run that IS the whole group saves nothing: the parent's own fold
    // already hid it, and a second chevron just puts the shelves two clicks
    // away instead of one.
    const wholeGroup = i === 0 && j === siblings.length;
    if (wholeGroup) {
      // Emit every member plainly, or the tail would be re-read as a shorter
      // run on the next pass.
      for (const m of members) out.push({ kind: "node", node: m });
      i = j;
      continue;
    }
    if (members.length >= MIN_RUN) {
      const nums = members.map((m) => split(m.name)!.n);
      out.push({
        kind: "run",
        run: {
          id: `run:${parentId ?? "root"}:${head.prefix.toLowerCase()}`,
          prefix: head.prefix,
          members,
          lo: Math.min(...nums),
          hi: Math.max(...nums),
        },
      });
      i = j;
    } else {
      out.push({ kind: "node", node: first });
      i++;
    }
  }
  return out;
}

/** Runs default closed: that is the whole point of drawing one. */
export function isRunOpen(overrides: FoldOverrides, runId: string): boolean {
  return overrides[runId] === true;
}

export function toggleRun(overrides: FoldOverrides, runId: string): FoldOverrides {
  const next = { ...overrides };
  if (isRunOpen(overrides, runId)) delete next[runId];
  else next[runId] = true;
  return next;
}

/** Every run anywhere in the forest, for Expand all. */
export function allRunIds<T extends FoldableNode>(roots: readonly T[]): string[] {
  const ids: string[] = [];
  const walk = (siblings: readonly T[], parentId: string | null) => {
    for (const e of groupRuns(siblings, parentId)) if (e.kind === "run") ids.push(e.run.id);
    for (const n of siblings) walk(n.children as T[], n.id);
  };
  walk(roots, null);
  return ids;
}

/** "rack" → "racks", "shelf" → "shelves", "box" → "boxes". Good enough for a
 *  summary chip; the member cards carry the real names. */
export function plural(word: string, n: number): string {
  if (n === 1) return word;
  const w = word.toLowerCase();
  if (/(?:f|fe)$/.test(w)) return word.replace(/fe?$/i, (m) => (m[0] === "F" ? "VES" : "ves"));
  if (/(?:s|x|z|ch|sh)$/.test(w)) return word + "es";
  if (/[^aeiou]y$/.test(w)) return word.slice(0, -1) + "ies";
  return word + "s";
}
