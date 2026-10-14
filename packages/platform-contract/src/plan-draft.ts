// A planning layout's body, shared by the page that edits it, the module that
// applies it and the assistant that proposes one. The module validates it
// (core-locations plan-drafts.ts); this is its shape and the pure parts both
// sides compute the same way.

/** A planned place is named in a draft as `planned:<key>`. */
export const PLANNED_PREFIX = "planned:";

export interface PlanRect {
  x_mm: number;
  y_mm: number;
  w_mm: number;
  d_mm: number;
  /** A quarter turn on the plan (plan-clearance.ts): w × d are as it stands. */
  rot?: 90 | 180 | 270;
}

export interface PlanDraftBody {
  /** Places that move: a new spot on their parent's plan, or a new parent. */
  moves: Record<string, { parent_id?: string; rect?: PlanRect }>;
  /** Where each thing goes, keyed `<kind>:<id>`. On a shelf, x_mm is how far
   *  from its left end it stands. */
  things: Record<string, { kind: string; id: string; into: string; x_mm?: number; y_mm?: number }>;
  /** Racks and shelves that do not exist yet; a shelf names its rack as
   *  `planned:<key>`. */
  planned: Array<{ key: string; name: string; parent: string; rect: PlanRect; face?: { w_mm: number; d_mm: number } }>;
}

export const EMPTY_PLAN_DRAFT: PlanDraftBody = { moves: {}, things: {}, planned: [] };

/** A rack that is not bought yet, with its shelves evenly spaced: the
 *  entries to add to a draft's `planned`. `size` is its outside (W × D × H). */
export function plannedRack(opts: {
  key: string;
  name: string;
  parent: string;
  at: { x_mm: number; y_mm: number };
  size: { w_mm: number; d_mm: number; h_mm: number };
  shelves: number;
}): PlanDraftBody["planned"] {
  const n = Math.max(1, Math.min(12, Math.round(opts.shelves)));
  const step = Math.round(opts.size.h_mm / n);
  return [
    {
      key: opts.key,
      name: opts.name,
      parent: opts.parent,
      rect: { x_mm: opts.at.x_mm, y_mm: opts.at.y_mm, w_mm: opts.size.w_mm, d_mm: opts.size.d_mm },
      face: { w_mm: opts.size.w_mm, d_mm: opts.size.h_mm },
    },
    ...Array.from({ length: n }, (_, i) => ({
      key: `${opts.key}-s${i + 1}`,
      name: `${opts.name} shelf ${i + 1}`,
      parent: `${PLANNED_PREFIX}${opts.key}`,
      rect: { x_mm: 0, y_mm: i * step, w_mm: opts.size.w_mm, d_mm: step },
    })),
  ];
}

/** Rename a planned rack without changing the keys its shelves and things use. */
export function renamePlannedRack(body: PlanDraftBody, id: string, name: string): PlanDraftBody {
  const rack = body.planned.find((p) => `${PLANNED_PREFIX}${p.key}` === id && !p.parent.startsWith(PLANNED_PREFIX));
  if (!rack) throw new Error("Choose a planned rack in this layout to rename.");
  const next = name.trim();
  if (!next || next.length > 180) throw new Error("Use a rack name of 1 to 180 characters.");
  return {
    ...body,
    planned: body.planned.map((p) => {
      if (p === rack) return { ...p, name: next };
      // Only names made by plannedRack follow the rack's name; custom shelf names stay.
      const suffix = p.name.slice(rack.name.length);
      if (p.parent === id && p.name.startsWith(rack.name) && /^ shelf \d+$/.test(suffix)) return { ...p, name: `${next}${suffix}` };
      return p;
    }),
  };
}

/** The places as the draft would leave them: each real place with its move
 *  applied (spot and parent), and each planned one as a place of its own
 *  whose id is `planned:<key>`. Nothing else about a place changes. */
export function placesUnderDraft<L extends { id: string; name: string; parent_id: string | null; kind: string; metadata: Record<string, unknown> }>(
  places: readonly L[],
  draft: PlanDraftBody,
): Array<L | (Omit<L, "id"> & { id: string; planned: true })> {
  const out: Array<L | (Omit<L, "id"> & { id: string; planned: true })> = places.map((p) => {
    const m = draft.moves[p.id];
    if (!m) return p;
    const fp = { ...(((p.metadata as { floorplan?: unknown }).floorplan ?? {}) as Record<string, unknown>) };
    if (m.rect) {
      // A turn the draft takes back off (a rack turned all the way round)
      // leaves no turn behind.
      const { rot, ...at } = m.rect;
      Object.assign(fp, at);
      if (rot) fp.rot = rot;
      else delete fp.rot;
    }
    // The place's layout is the one key a draft changes; the rest of its metadata rides along.
    const metadata = Object.assign({}, p.metadata, { floorplan: fp });
    return { ...p, parent_id: m.parent_id ?? p.parent_id, metadata };
  });
  const template = places[0];
  for (const pl of draft.planned) {
    const fp: Record<string, unknown> = { ...pl.rect };
    if (pl.face) fp.face = { ...pl.face, view: "front", unit: "mm" };
    out.push({
      ...(template ?? ({} as L)),
      id: `${PLANNED_PREFIX}${pl.key}`,
      name: pl.name,
      parent_id: pl.parent,
      kind: "container",
      metadata: { floorplan: fp },
      planned: true,
    } as Omit<L, "id"> & { id: string; planned: true });
  }
  return out;
}

/** An applied draft as it is drawn: each planned place Apply made is the
 *  real place now (`made`: planned key to its id), so it is not drawn a
 *  second time beside it, still marked planned (#6363), and what the draft
 *  put on a planned shelf stands on the real one. Unapplied, or undone, the
 *  body is drawn as it is. */
export function bodyAsApplied(body: PlanDraftBody, made: Readonly<Record<string, string>> | null | undefined): PlanDraftBody {
  if (!made || !Object.keys(made).length) return body;
  const real = (ref: string) => (ref.startsWith(PLANNED_PREFIX) ? (made[ref.slice(PLANNED_PREFIX.length)] ?? ref) : ref);
  return {
    moves: body.moves,
    things: Object.fromEntries(Object.entries(body.things).map(([k, t]) => [k, { ...t, into: real(t.into) }])),
    planned: body.planned.filter((p) => !(p.key in made)).map((p) => ({ ...p, parent: real(p.parent) })),
  };
}

/** What applying the draft would do, counted, for the button that does it
 *  ("Move 14 things, 2 places; make 1 rack"). */
export function draftSummary(draft: PlanDraftBody): { things: number; places: number; planned: number } {
  return {
    things: Object.keys(draft.things).length,
    places: Object.keys(draft.moves).length,
    planned: draft.planned.filter((p) => !p.parent.startsWith(PLANNED_PREFIX)).length,
  };
}
