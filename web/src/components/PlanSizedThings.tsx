// Things drawn at their real size on a plan, and whether they fit.
//
// A placed thing whose kind carries an outer size (the `outer-size` field
// role) is drawn as a rectangle instead of a pin: its footprint on a floor,
// its face on a shelf. On a face, the things on each shelf stand side by
// side from the left, and the shelf says whether they fit, with the numbers.
// A thing with no size stays a pin (or a name in the tray), and the plan
// offers to take its size. The pure part is lib/planFit.ts.
// See docs/design-decisions/location-floor-plan.md, "Things at their real size".

import { useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { EntityPhoto, Modal, changeWorkspaceShape, useImageSrc, useToast } from "@cobblr/platform-web";
import { fieldScopeSentinel } from "@cobblr/platform-contract";
import { fieldKindOf } from "@cobblr/platform-contract/kind-label";
import { OUTER_SIZE_FIELD, OUTER_SIZE_ROLE, parseOuterSize, type OuterSize } from "@cobblr/platform-contract/outer-size";
import { ApiError, api, type Location, type PlacedThing, type PlatformEntityKind } from "../lib/api";
import { hasOwnLayout, readRect, type FpBound, type FpRect } from "../lib/floorplanGeometry";
import { footprintAt, nameUnder, outerSizeOf, reorderTo, shelfFitLine, shelfRow, sizeFieldNames, type ShelfRow } from "../lib/planFit";
import { LOCATION_KIND } from "../lib/placeItems";
import { placesOf, type PlaceableRecord } from "../lib/placeableRecords";

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

export interface SizedThing {
  key: string;
  kind: string;
  id: string;
  name: string;
  image_path: string | null;
  size: OuterSize;
  rect: FpRect;
  /** The shelf it stands on, on a face. */
  shelfId?: string;
  overhang?: boolean;
  tooTall?: boolean;
}

export interface ShelfFit {
  shelfId: string;
  shelfRect: FpRect;
  row: ShelfRow;
  line: string;
  /** Things on this shelf with no size yet, which the line cannot count. */
  unsized: number;
}

export interface UnsizedThing {
  kind: string;
  id: string;
  name: string;
}

interface Occupant {
  kind: string;
  id: string;
  name: string;
  image_path: string | null;
  location_id: string | null;
}

/** Everything the plan needs to draw things at their size: the rects, the
 *  shelf rows with their fit lines, and what still has no size. */
export function useSizedThings(opts: {
  slug: string;
  bound: FpBound | null;
  room: Location;
  pins: readonly PlacedThing[];
  occupants: readonly Occupant[];
  shelves: ReadonlyArray<{ loc: Location; rect: FpRect }>;
  placeable: readonly PlaceableRecord[];
  placeableKinds: readonly PlatformEntityKind[];
  /** How much of each shelf's top is its label band, in the face's mm. */
  band_mm?: number;
}) {
  const { slug, bound, room, pins, shelves, placeable } = opts;
  const band = opts.band_mm ?? 0;
  const front = bound?.view === "front";
  // A shelf with a layout of its own draws its things there, not here. (Its
  // rect on this face reads as a bound too, so the plan's own occupant list
  // files its things under the shelf: they are read here from every
  // placeable record, by the places each is kept in.)
  const openShelves = useMemo(() => (front ? shelves.filter((s) => !hasOwnLayout(s.loc.metadata)) : []), [front, shelves]);
  const onShelves = useMemo(() => {
    const ids = new Set(openShelves.map((s) => s.loc.id));
    const out: Occupant[] = [];
    for (const r of placeable) for (const at of placesOf(r)) if (ids.has(at)) out.push({ kind: r.kind, id: r.id, name: r.name, image_path: r.image_path, location_id: at });
    return out;
  }, [placeable, openShelves]);

  const byKey = useMemo(() => new Map(placeable.map((r) => [`${fieldKindOf(r)}:${r.id}`, r])), [placeable]);
  const kinds = useMemo(
    () => [...new Set([...pins.map((t) => fieldKindOf(t)), ...onShelves.map((o) => fieldKindOf(byKey.get(`${fieldKindOf(o)}:${o.id}`) ?? o))])].sort(),
    [pins, onShelves, byKey],
  );
  const defs = useQueries({
    queries: kinds.map((k) => ({
      queryKey: ["field-defs", slug, k],
      queryFn: () => api.listFieldDefs(slug, k),
      staleTime: 60_000,
    })),
    combine: (rs) => rs.flatMap((r) => r.data?.items ?? []),
  });
  // Where each thing stands along its shelf, when somebody put it somewhere.
  const shelfContents = useQueries({
    queries: openShelves.map((s) => ({
      queryKey: ["location-contents", slug, s.loc.id],
      queryFn: () => api.placementContents(slug, LOCATION_KIND, s.loc.id),
      staleTime: 30_000,
    })),
    combine: (rs) => rs.map((r) => r.data?.items ?? []),
  });

  const sizeOf = (kind: string, id: string, fields?: Record<string, unknown>): OuterSize | null => {
    const fk = fieldKindOf({ kind });
    const rec = byKey.get(`${fk}:${id}`);
    const names = sizeFieldNames(defs, fieldKindOf(rec ?? { kind }));
    return outerSizeOf(rec?.metadata, names) ?? outerSizeOf(fields, names);
  };

  return useMemo(() => {
    const things: SizedThing[] = [];
    const unsized: UnsizedThing[] = [];
    const sizedPinKeys = new Set<string>();
    const drawnOnShelf = new Set<string>();
    const fits: ShelfFit[] = [];
    if (!bound) return { things, fits, unsized, sizedPinKeys, drawnOnShelf };
    for (const t of pins) {
      const key = `${t.kind}:${t.id}`;
      const size = sizeOf(t.kind, t.id, t.fields);
      if (!size || !t.position) {
        unsized.push({ kind: t.kind, id: t.id, name: t.title });
        continue;
      }
      sizedPinKeys.add(key);
      const rect = front
        ? { x_mm: Math.round(t.position.x_mm - size.w_mm / 2), y_mm: Math.round(t.position.y_mm - (size.h_mm ?? size.d_mm)), w_mm: size.w_mm, d_mm: size.h_mm ?? size.d_mm }
        : footprintAt(size, t.position);
      things.push({ key, kind: t.kind, id: t.id, name: t.title, image_path: t.image_path ?? null, size, rect });
    }
    // How deep the shelves are: the rack's own footprint, when it stands on a floor.
    const depth = readRect(room.metadata)?.d_mm ?? null;
    openShelves.forEach((s, i) => {
      const order = new Map((shelfContents[i] ?? []).map((c) => [`${fieldKindOf(c)}:${c.id}`, c.position?.x_mm ?? null]));
      const here = onShelves.filter((o) => o.location_id === s.loc.id);
      const sized = here
        .map((o) => {
          const fk = fieldKindOf(byKey.get(`${fieldKindOf(o)}:${o.id}`) ?? o);
          return { o, key: `${fk}:${o.id}`, size: sizeOf(o.kind, o.id) };
        })
        .filter((x): x is { o: Occupant; key: string; size: OuterSize } => !!x.size);
      for (const o of here) if (!sized.some((x) => x.o === o)) unsized.push({ kind: o.kind, id: o.id, name: o.name });
      if (!sized.length) return;
      const row = shelfRow(
        s.rect,
        sized.map(({ o, key, size }) => ({ key, size, order: order.get(key) ?? null, name: o.name })),
        depth,
        band,
      );
      for (const { o, key, size } of sized) {
        drawnOnShelf.add(key);
        things.push({
          key,
          kind: o.kind,
          id: o.id,
          name: o.name,
          image_path: o.image_path,
          size,
          rect: row.rects.get(key)!,
          shelfId: s.loc.id,
          overhang: row.overhang.has(key),
          tooTall: row.tooTall.has(key),
        });
      }
      const collections = new Set(sized.map(({ o }) => byKey.get(`${fieldKindOf(o)}:${o.id}`)?.collection ?? ""));
      const one = collections.size === 1 ? [...collections][0]!.toLowerCase() : "";
      const noun = one ? { one: one.replace(/s$/, ""), many: one } : { one: "thing", many: "things" };
      fits.push({ shelfId: s.loc.id, shelfRect: s.rect, row, line: shelfFitLine(row, s.rect.w_mm, noun, sized.length), unsized: here.length - sized.length });
    });
    return { things, fits, unsized, sizedPinKeys, drawnOnShelf };
    // sizeOf reads defs and byKey, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, front, pins, room.metadata, openShelves, onShelves, shelfContents, defs, byKey, band]);
}

/** One thing at its size. On a shelf, a drag along it reorders the row. */
export function SizedThingBox({
  slug,
  thing,
  bound,
  colliding,
  canDrag,
  shelf,
  planEl,
  onOpen,
}: {
  slug: string;
  thing: SizedThing;
  bound: FpBound;
  colliding: boolean;
  canDrag: boolean;
  shelf: ShelfFit | null;
  planEl: HTMLElement | null;
  onOpen: () => void;
}) {
  const r = thing.rect;
  const src = useImageSrc(thing.image_path);
  const qc = useQueryClient();
  const toast = useToast();
  const [dx, setDx] = useState(0);
  const moved = useRef(false);
  // A finger has no hover: its first tap shows the whole name, the next opens.
  const pointer = useRef("mouse");
  const [peek, setPeek] = useState(false);
  const pxW = planEl ? (r.w_mm / bound.w_mm) * planEl.clientWidth : 100;
  const pxH = planEl ? (r.d_mm / bound.d_mm) * planEl.clientHeight : 100;
  const bad = colliding || thing.overhang || thing.tooTall || (shelf ? !shelf.row.fits && r.x_mm + r.w_mm > shelf.shelfRect.x_mm + shelf.shelfRect.w_mm : false);
  const why = [
    thing.overhang ? "deeper than the shelf: it hangs off the front" : null,
    thing.tooTall ? "taller than the space above the shelf" : null,
    colliding ? "overlaps something else" : null,
  ].filter(Boolean);

  const writeOrder = async (spots: Array<{ key: string; x_mm: number }>, before: Map<string, number | null>) => {
    if (!shelf) return;
    const place = (key: string, x: number | null) => {
      const t = key.slice(key.lastIndexOf(":") + 1);
      const kind = key.slice(0, key.lastIndexOf(":"));
      return api.placementPlace(slug, {
        containee: { kind, id: t },
        container: { kind: LOCATION_KIND, id: shelf.shelfId },
        position: x === null ? null : { x_mm: x, y_mm: 0 },
        via: "floor plan",
      });
    };
    try {
      for (const s of spots) await place(s.key, s.x_mm);
      void qc.invalidateQueries({ queryKey: ["location-contents", slug, shelf.shelfId] });
      toast.action(`Moved ${thing.name} along the shelf`, {
        actionLabel: "Undo",
        onAction: async () => {
          for (const s of spots) await place(s.key, before.get(s.key) ?? null);
          void qc.invalidateQueries({ queryKey: ["location-contents", slug, shelf.shelfId] });
        },
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    pointer.current = e.pointerType;
    if (!canDrag || !shelf || !planEl) return;
    e.preventDefault();
    e.stopPropagation();
    moved.current = false;
    const startX = e.clientX;
    const mmPerPx = bound.w_mm / planEl.clientWidth;
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - startX) * mmPerPx;
      if (Math.abs(ev.clientX - startX) > 4) moved.current = true;
      setDx(d);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDx(0);
      if (!moved.current) return;
      const centre = r.x_mm - shelf.shelfRect.x_mm + r.w_mm / 2 + (ev.clientX - startX) * mmPerPx;
      const spots = reorderTo(shelf.row, shelf.shelfRect, thing.key, centre);
      const before = new Map(shelf.row.order.map((k) => [k, shelf.row.rects.get(k)!.x_mm - shelf.shelfRect.x_mm]));
      if (spots.every((s, i) => s.key === shelf.row.order[i])) return;
      void writeOrder(spots, before);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <button
      type="button"
      data-sized-thing={thing.id}
      data-size-mm={`${thing.size.w_mm}x${thing.size.d_mm}${thing.size.h_mm ? `x${thing.size.h_mm}` : ""}`}
      data-drawn-mm={`${r.w_mm}x${r.d_mm}`}
      data-misfit={bad ? "true" : undefined}
      title={[thing.name, ...why].join(": ")}
      aria-label={[thing.name, ...why].join(", ")}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        if (moved.current) return;
        if (pointer.current === "touch" && !peek) {
          setPeek(true);
          return;
        }
        onOpen();
      }}
      onBlur={() => setPeek(false)}
      className={`absolute ${peek ? "overflow-visible" : "overflow-hidden"} rounded-[3px] border text-left text-[10px] leading-tight px-1 py-0.5 text-content dark:text-slate-100
        ${bad ? "border-ember-500 bg-ember-50 dark:bg-ember-950" : "border-cobble-500/80 dark:border-cobble-400/70 bg-cobble-100 dark:bg-cobble-900"}
        ${canDrag && shelf ? "cursor-grab touch-none" : "cursor-pointer hover:border-accent"}`}
      style={{
        left: pct(r.x_mm + dx, bound.w_mm),
        top: pct(r.y_mm, bound.d_mm),
        width: pct(r.w_mm, bound.w_mm),
        height: pct(r.d_mm, bound.d_mm),
        zIndex: dx ? 20 : undefined,
      }}
    >
      {src && pxW >= 44 && pxH >= 44 && <EntityPhoto src={src} alt="" size={24} className="float-right ml-0.5 rounded-sm opacity-90" />}
      {pxW >= 24 && (
        <span data-face-text="" className="block truncate">
          {thing.name}
        </span>
      )}
      {peek && (
        <span
          data-thing-peek=""
          className="absolute left-0 top-0 z-30 w-max max-w-[16rem] whitespace-normal rounded bg-surface dark:bg-slate-800 px-1.5 py-1 text-[11px] text-content dark:text-slate-100 shadow-md"
        >
          {thing.name}
        </span>
      )}
    </button>
  );
}

/** On a shelf, the second line of its label band (under its name): how
 *  much of it the things on it take, whole, red when it does not fit. */
export function ShelfFitLabel({ fit, bound }: { fit: ShelfFit; bound: FpBound }) {
  const r = fit.shelfRect;
  const n = (v: number) => v.toLocaleString("en-US");
  const over = fit.row.used_mm - r.w_mm;
  return (
    <span
      data-shelf-fit={fit.shelfId}
      data-fits={fit.row.fits ? "true" : "false"}
      data-face-text=""
      title={fit.line}
      className={`absolute pointer-events-none whitespace-nowrap px-1 text-[10px] leading-[13px] ${fit.row.fits ? "text-muted dark:text-slate-400" : "font-medium text-ember-700 dark:text-ember-300"}`}
      style={{ left: pct(r.x_mm, bound.w_mm), top: `calc(${pct(r.y_mm, bound.d_mm)} + 17px)` }}
    >
      {n(fit.row.used_mm)} of {n(r.w_mm)} mm: {fit.row.fits ? `${n(-over)} mm free` : `${n(over)} mm too wide`}
    </span>
  );
}

/** Under the plan: each shelf's whole line, the ones that do not fit first. */
export function ShelfFitList({ fits, names, rack }: { fits: readonly ShelfFit[]; names: Map<string, string>; rack: string }) {
  if (fits.length === 0) return null;
  const sorted = [...fits].sort((a, b) => Number(a.row.fits) - Number(b.row.fits));
  return (
    <ul data-testid="shelf-fits" className="mt-2 space-y-0.5 text-xs">
      {sorted.map((f) => (
        <li key={f.shelfId} className={f.row.fits ? "text-muted dark:text-slate-400" : "font-medium text-ember-700 dark:text-ember-300"}>
          <span className="text-content dark:text-slate-200">{nameUnder(names.get(f.shelfId) ?? "Shelf", rack)}:</span> {f.line}
          {f.unsized > 0 ? `; ${f.unsized} without a size` : ""}
        </li>
      ))}
    </ul>
  );
}

/** "Add its size to see if it fits": one line per thing, any unit. The size
 *  goes in the workspace's Outer size field (made on first use, on every
 *  physical kind at once), so the record page, the api and the assistant all
 *  read the same value. */
export function AddSizesDialog({
  slug,
  things,
  placeable,
  placeableKinds,
  onClose,
}: {
  slug: string;
  things: readonly UnsizedThing[];
  placeable: readonly PlaceableRecord[];
  placeableKinds: readonly PlatformEntityKind[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const keyOf = (t: UnsizedThing) => `${t.kind}:${t.id}`;
  const bad = Object.entries(values).filter(([, v]) => v.trim() && !parseOuterSize(v));

  const save = async () => {
    setBusy(true);
    try {
      const todo = things.filter((t) => (values[keyOf(t)] ?? "").trim());
      for (const t of todo) {
        const rec = placeable.find((r) => r.id === t.id && fieldKindOf(r) === fieldKindOf(t));
        const fk = fieldKindOf(rec ?? t);
        const defs = (await api.listFieldDefs(slug, fk)).items;
        let field = defs.find((d) => d.field_role === OUTER_SIZE_ROLE)?.name;
        if (!field) {
          const made = await changeWorkspaceShape(qc, slug, () =>
            api.createFieldDef(slug, {
              entity_kind: fieldScopeSentinel(["physical"]),
              applies_to: { traits: ["physical"] },
              name: OUTER_SIZE_FIELD,
              display_label: "Outer size",
              type: "text",
              field_role: OUTER_SIZE_ROLE,
            } as never),
          );
          field = made.name;
        }
        const k = placeableKinds.find((pk) => pk.id === (rec?.kind ?? t.kind));
        const tmpl = k?.endpoints?.update;
        if (!k || !tmpl) throw new ApiError(400, "not_writable", `${t.name} cannot be written here`);
        const path = `/orgs/${slug}/${k.instance_name ? `instances/${k.instance_name}` : `modules/${k.module_name}`}${tmpl.replace("{id}", t.id)}`;
        await api.request("PATCH", path, { metadata: { [field]: values[keyOf(t)]!.trim() } });
      }
      void qc.invalidateQueries({ queryKey: ["kind-list", slug] });
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
      toast.success(todo.length === 1 ? `Saved the size of ${todo[0]!.name}` : `Saved ${todo.length} sizes`);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Add sizes to see if they fit" size="md">
      <div className="space-y-3">
        <p className="text-xs text-muted dark:text-slate-400">
          Width × depth × height of the outside, in any unit: 600 x 550 x 700 mm, 24 x 20 x 28 in.
        </p>
        <ul className="space-y-2">
          {things.map((t) => {
            const v = values[keyOf(t)] ?? "";
            const parsed = v.trim() ? parseOuterSize(v) : null;
            return (
              <li key={keyOf(t)} className="flex items-center gap-2">
                <label className="flex-1 min-w-0 truncate text-sm text-content dark:text-slate-200" htmlFor={`size-${keyOf(t)}`}>
                  {t.name}
                </label>
                <input
                  id={`size-${keyOf(t)}`}
                  data-size-input={t.id}
                  value={v}
                  placeholder="W x D x H"
                  onChange={(e) => setValues((s) => ({ ...s, [keyOf(t)]: e.target.value }))}
                  className={`w-44 rounded border px-2 py-1 text-sm bg-surface dark:bg-slate-900 ${v.trim() && !parsed ? "border-ember-500" : "border-line dark:border-slate-600"}`}
                />
              </li>
            );
          })}
        </ul>
        {bad.length > 0 && <p className="text-xs text-ember-700 dark:text-ember-300">Write it as width x depth x height, like 600 x 550 x 700 mm.</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-muted hover:text-content">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || bad.length > 0 || !Object.values(values).some((v) => v.trim())}
            onClick={() => void save()}
            className="rounded bg-cobble-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Save sizes
          </button>
        </div>
      </div>
    </Modal>
  );
}
