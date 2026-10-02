// Place items: the floor plan on the left, the things to put somewhere on the
// right, and a person drags each thing to the exact place it lives ("the
// garage, the blue toolbox, drawer 3"). The feedback that asked for it wanted
// the plan at about three quarters of the width and a rail of chips beside it.
//
// Two ways to put a thing somewhere, the same on every device: drag its chip
// onto a place (a mouse), or pick it up (a tap, or a long press on a touch
// screen) and tap the place. On a phone the rail is a sheet over a
// full-width plan. A drop on a place with smaller places inside it asks which
// one, so a drawer too small to draw is still one tap away. A thing kept in
// several places asks what to move. Every move can be undone, and reads
// "moved via floor plan" in the activity.

import { swallowNextClick } from "../../lib/swallow-click";
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { EntityThumb, FloatingChrome, Modal, PopoverLayer, SearchInput, StockStepper, useToast } from "@cobblr/platform-web";
import { ApiError, api, type Location } from "../../lib/api";
import { hasOwnLayout, readBound, readRect } from "../../lib/floorplanGeometry";
import { useIsDesktopWidth } from "../../lib/useIsDesktopWidth";
import { usePlaceableRecords, placesOf, type PlaceableRecord } from "../../lib/placeableRecords";
import { countsByPlace, countsWithin, pathOf, placeChoices, railItems, type RailFilter } from "../../lib/placeItems";
import { FaceFor, FloorPlan } from "../FloorPlan";
import { PlacingContext, placeAtPoint, type Pin, type Placing } from "./placing";
import { usePlaceActions, type Undo } from "./usePlaceActions";
import { SeveralPlacesDialog, type SeveralPlacesAnswer } from "./SeveralPlacesDialog";

/** What the toast says once something is put somewhere. A drop on a plan's
 *  bare floor is a pin at that spot, and saying only "is in Kitchen now"
 *  left the person wondering where in the kitchen it went (#4147). */
export function placedSaying(names: string, where: string, pinned: boolean): string {
  return pinned ? `${names} is pinned here, in ${where}` : `${names} is in ${where} now`;
}

const keyOf = (r: PlaceableRecord) => `${r.kind}:${r.id}`;

/** What a person is carrying across spaces, and how the rail is narrowed. */
export interface PlaceSession {
  picked: Set<string>;
  setPicked: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  filter: RailFilter;
  setFilter: (next: RailFilter | ((prev: RailFilter) => RailFilter)) => void;
}

/** The session, held by whatever outlives a change of space (the page). */
export function usePlaceSession(collection: string | null = null): PlaceSession {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<RailFilter>(() => ({ showAll: false, q: "", collection }));
  return { picked, setPicked, filter, setFilter };
}
const LONG_PRESS_MS = 450;
const DRAG_START_PX = 6;

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
}

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
}

interface Press {
  key: string;
  from: "rail" | "plan";
  x: number;
  y: number;
  pointerType: string;
  timer: number;
  long: boolean;
  moved: boolean;
}

export function PlaceItemsView({
  slug,
  space,
  locations,
  session,
}: {
  slug: string;
  /** The room or container whose plan is shown. */
  space: Location;
  locations: Location[];
  /** What is picked up and how the rail is narrowed, owned by the page so a
   *  change of space keeps both (#4561). */
  session: PlaceSession;
}) {
  const isDesktop = useIsDesktopWidth();
  const toast = useToast();
  const { records, kinds, isLoading } = usePlaceableRecords(slug, { fresh: true });
  const actions = usePlaceActions(slug);
  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l] as const)), [locations]);
  const byKey = useMemo(() => new Map(records.map((r) => [keyOf(r), r] as const)), [records]);
  const direct = useMemo(() => countsByPlace(records), [records]);
  const within = useMemo(() => countsWithin(direct, locations), [direct, locations]);

  const { picked, setPicked, filter, setFilter } = session;
  const [over, setOver] = useState<string | null>(null);
  const [choose, setChoose] = useState<{ locationId: string; keys: string[] } | null>(null);
  const [ask, setAsk] = useState<{ queue: PlaceableRecord[]; locationId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [drag, setDrag] = useState<{ keys: string[]; x: number; y: number } | null>(null);
  const dragging = useRef<{ keys: string[]; from: "rail" | "plan" } | null>(null);

  const listed = useMemo(() => railItems(records, filter), [records, filter]);
  const unplacedCount = useMemo(() => records.filter((r) => placesOf(r).length === 0).length, [records]);
  // The count says what the list shows: narrowed by a collection or a
  // search, "3 of 16 without a place", never the workspace's 16 over a list
  // of 3 (#4437).
  const narrowed = !!filter.q || !!filter.collection;
  const unplacedShown = useMemo(() => railItems(records, { ...filter, showAll: false }).length, [records, filter]);
  const withoutAPlace = narrowed ? `${unplacedShown} of ${unplacedCount} without a place` : `${unplacedCount} without a place`;
  const collections = useMemo(
    () => kinds.filter((k) => records.some((r) => r.kind === k.id)).map((k) => ({ id: k.id, name: k.display_name_plural || k.display_name })),
    [kinds, records],
  );
  const nameOf = (keys: string[]) => (keys.length === 1 ? (byKey.get(keys[0]!)?.name ?? "1 thing") : `${keys.length} things`);

  const toggle = (key: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  // ── the moves ──
  const place = async (keys: string[], locationId: string, position?: Pin | null) => {
    const recs = keys.map((k) => byKey.get(k)).filter((r): r is PlaceableRecord => !!r);
    const several = recs.filter((r) => r.holdings);
    const single = recs.filter((r) => !r.holdings);
    setPicked(new Set());
    if (single.length) {
      setBusy(true);
      const undos: Undo[] = [];
      try {
        for (const r of single) undos.push(await actions.move(r, locationId, position));
        toast.action(placedSaying(nameOf(single.map(keyOf)), pathOf(locationId, byId), !!position), {
          actionLabel: "Undo",
          duration: 8000,
          onAction: async () => {
            for (const u of undos.reverse()) await u();
            actions.refresh();
          },
        });
      } catch (e) {
        toast.error(errorText(e));
      } finally {
        actions.refresh();
        setBusy(false);
      }
    }
    if (several.length) setAsk({ queue: several, locationId });
  };
  /** A drop or a tap with things picked up: a place with smaller places in it
   *  asks which one first; a spot on a plan's bare floor is already the
   *  answer (right there, pinned). */
  const begin = (keys: string[], locationId: string, position?: Pin | null) => {
    if (position) void place(keys, locationId, position);
    else if (placeChoices(locationId, locations).length > 1) setChoose({ locationId, keys });
    else void place(keys, locationId);
  };
  /** The place's own face, when it has one with drawers drawn on it. */
  const faceOf = (id: string): Location | null => {
    const l = byId.get(id);
    if (!l || !hasOwnLayout(l.metadata)) return null;
    return locations.some((c) => c.parent_id === id && readRect(c.metadata)) ? l : null;
  };
  const unplace = async (keys: string[]) => {
    const recs = keys.map((k) => byKey.get(k)).filter((r): r is PlaceableRecord => !!r && !r.holdings);
    if (!recs.length) return;
    setBusy(true);
    try {
      const undos: Undo[] = [];
      for (const r of recs) undos.push(await actions.unplace(r));
      toast.action(`${nameOf(recs.map(keyOf))} has no place now`, {
        actionLabel: "Undo",
        duration: 8000,
        onAction: async () => {
          for (const u of undos.reverse()) await u();
          actions.refresh();
        },
      });
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      actions.refresh();
      setBusy(false);
    }
  };
  const answer = async (a: SeveralPlacesAnswer) => {
    if (!ask) return;
    const r = ask.queue[0]!;
    const where = pathOf(ask.locationId, byId);
    setBusy(true);
    try {
      if (a.kind === "all") {
        await actions.moveAll(r, ask.locationId);
        toast.success(`All of ${r.name} is in ${where} now`);
      } else if (a.kind === "some") {
        const undo = await actions.moveSome(r, a.fromHoldingId, a.fromLocationId, ask.locationId, a.qty);
        const msg = `${fmt(a.qty)} of ${r.name} moved to ${where}`;
        if (undo) toast.action(msg, { actionLabel: "Undo", duration: 8000, onAction: async () => { await undo(); actions.refresh(); } });
        else toast.success(msg);
      } else {
        await actions.addPlace(r, ask.locationId, a.qty);
        toast.success(`${r.name} is kept in ${where} too`);
      }
      actions.refresh();
      const rest = ask.queue.slice(1);
      setAsk(rest.length ? { queue: rest, locationId: ask.locationId } : null);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // ── the plan's side of place mode ──
  const placing: Placing = {
    armed: picked.size > 0,
    countAt: (id) => direct.get(id) ?? 0,
    withinAt: (id) => within.get(id) ?? 0,
    over,
    pick: (id, position) => {
      if (picked.size > 0) begin([...picked], id, position);
      else {
        setPreviewId(id);
        if (!isDesktop) setSheetOpen(true);
      }
    },
  };

  // ── drag and press: a mouse drags; a touch picks up on a long press ──
  const onChipDown = (e: ReactPointerEvent, key: string, from: "rail" | "plan") => {
    if (e.button !== 0) return;
    if (e.pointerType === "mouse") e.preventDefault();
    const p: Press = { key, from, x: e.clientX, y: e.clientY, pointerType: e.pointerType, timer: 0, long: false, moved: false };
    if (e.pointerType !== "mouse") {
      p.timer = window.setTimeout(() => {
        p.long = true;
        setPicked((s) => new Set(s).add(key));
        navigator.vibrate?.(15);
      }, LONG_PRESS_MS);
    }
    const keysFor = () => (picked.has(key) ? [...picked] : [key]);
    const move = (ev: PointerEvent) => {
      if (!p.moved && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > DRAG_START_PX) {
        p.moved = true;
        window.clearTimeout(p.timer);
        if (p.pointerType === "mouse") dragging.current = { keys: keysFor(), from };
      }
      if (dragging.current) {
        setDrag({ keys: dragging.current.keys, x: ev.clientX, y: ev.clientY });
        setOver(placeAtPoint(ev.clientX, ev.clientY)?.id ?? null);
      }
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.clearTimeout(p.timer);
      const d = dragging.current;
      dragging.current = null;
      setDrag(null);
      setOver(null);
      if (d) {
        if (ev.type === "pointercancel") return;
        const target = placeAtPoint(ev.clientX, ev.clientY);
        const onRail = !!document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-place-rail]");
        if (target) begin(d.keys, target.id, target.position);
        else if (onRail && d.from === "plan") void unplace(d.keys);
        return;
      }
      if (p.long) {
        // Picked up. The sheet goes on the lift, not under the finger, and
        // the click the browser sends after a long press (which lands on
        // whatever is under the finger once the sheet has gone: the plan)
        // must not put the thing down there.
        swallowNextClick();
        if (!isDesktop) setSheetOpen(false);
        return;
      }
      if (!p.moved && ev.type !== "pointercancel") {
        const pickingUp = !picked.has(key);
        toggle(key);
        // On a phone the drawer covers the plan: a thing picked up from it
        // needs the plan in view to be put down (#4436). The bar it folds to
        // says what is picked up, and opens again to pick more.
        if (pickingUp && from === "rail" && !isDesktop) setSheetOpen(false);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  // ── pieces ──
  const chip = (r: PlaceableRecord, from: "rail" | "plan") => {
    const key = keyOf(r);
    const on = picked.has(key);
    const places = placesOf(r);
    return (
      <button
        type="button"
        data-place-chip={key}
        aria-pressed={on}
        onPointerDown={(e) => onChipDown(e, key, from)}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle(key);
          }
        }}
        title={on ? `${r.name}: picked up, tap a place` : `${r.name}: drag onto a place, or tap to pick it up`}
        className={
          "w-full min-w-0 flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm select-none touch-manipulation transition " +
          (on
            ? "border-accent bg-cobble-50 dark:bg-cobble-900/30 ring-1 ring-accent"
            : "border-line dark:border-slate-700 bg-surface dark:bg-slate-900 hover:border-accent")
        }
      >
        <EntityThumb src={r.image_path} alt="" size={32} className="shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-content dark:text-mortar-100">{r.name}</span>
          <span className="block truncate text-[11px] text-faint dark:text-slate-500">
            {r.collection}
            {places.length > 0 && from === "rail" ? ` · ${places.length > 1 ? `${places.length} places` : pathOf(places[0]!, byId)}` : ""}
          </span>
        </span>
        {r.qty !== null && <span className="shrink-0 font-mono text-xs text-muted">×{fmt(r.qty)}</span>}
      </button>
    );
  };

  const previewRows = previewId ? records.filter((r) => placesOf(r).includes(previewId)) : [];
  const preview = previewId && (
    <div className="flex flex-col min-h-0 gap-2" data-testid="place-preview">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint">In</div>
          <div className="font-medium text-content dark:text-mortar-100">{pathOf(previewId, byId)}</div>
          <div className="text-xs text-muted">
            {previewRows.length === 0 ? "Nothing here yet" : `${previewRows.length} ${previewRows.length === 1 ? "thing" : "things"} here`}
            {(within.get(previewId) ?? 0) > previewRows.length ? `, ${within.get(previewId)} with what is inside it` : ""}
          </div>
        </div>
        <button type="button" onClick={() => setPreviewId(null)} aria-label="Back to the things to place" className="p-1 text-muted hover:text-accent">
          <X size={16} />
        </button>
      </div>
      <ul className="space-y-1.5 overflow-y-auto">
        {previewRows.map((r) => {
          const here = r.holdings?.find((h) => h.location_id === previewId);
          const qty = here ? here.qty : r.qty;
          return (
            <li key={keyOf(r)} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">{chip(r, "plan")}</div>
              {r.module === "inventory" && qty !== null && (
                <StockStepper
                  size="sm"
                  qty={qty}
                  label={r.name}
                  onStep={async (d) => {
                    const out = await api.stockAdjustAt(slug, r.instance ?? "inventory", here?.id ?? r.id, d);
                    actions.refresh();
                    return Number(out.qty);
                  }}
                />
              )}
              {!r.holdings && (
                <button type="button" onClick={() => void unplace([keyOf(r)])} disabled={busy} className="shrink-0 text-xs text-muted hover:text-accent">
                  Take out
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );

  const railBody = (
    <div data-place-rail className="flex flex-col min-h-0 h-full gap-2">
      {preview || (
        <>
          {/* On a phone the sheet's own bar already says this. */}
          {isDesktop && (
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Things to place</h2>
              <span className="text-xs text-muted">{withoutAPlace}</span>
            </div>
          )}
          <SearchInput
            value={filter.q}
            onChange={(q) => setFilter((f) => ({ ...f, q }))}
            // vocab-lint-ok: the rail lists every collection's records at once; "things" is the one neutral word for all of them
            placeholder="Search things"
            aria-label="Search things"
            size="sm"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              aria-label="Collection"
              value={filter.collection ?? ""}
              onChange={(e) => setFilter((f) => ({ ...f, collection: e.target.value || null }))}
              className="input !py-1 !w-auto text-xs"
            >
              <option value="">Every collection</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1 text-muted">
              <input type="checkbox" checked={filter.showAll} onChange={(e) => setFilter((f) => ({ ...f, showAll: e.target.checked }))} />
              Show things that have a place
            </label>
          </div>
          <ul className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-0.5" data-testid="place-rail-list">
            {listed.map((r) => (
              <li key={keyOf(r)}>{chip(r, "rail")}</li>
            ))}
          </ul>
          {!isLoading && listed.length === 0 && (
            <p className="rounded-lg border border-dashed border-line dark:border-slate-700 p-3 text-sm text-muted" data-testid="place-rail-empty">
              {records.length > 0 && unplacedCount === 0 && !filter.showAll && !filter.q && !filter.collection
                ? "Everything has a home 🎉"
                : records.length === 0
                  ? "Nothing to place yet. Add a few things and they will wait here for a home."
                  : "Nothing here matches."}
            </p>
          )}
        </>
      )}
    </div>
  );

  const hasPlan = !!readBound(space.metadata) || locations.some((l) => l.parent_id === space.id && readBound(l.metadata));

  return (
    <PlacingContext.Provider value={placing}>
      {picked.size > 0 && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2 text-sm" data-testid="place-armed">
          <span className="min-w-0 flex-1">
            {nameOf([...picked])} picked up. {isDesktop ? "Drag onto a place, or click one." : "Tap the place it goes."}
          </span>
          <button type="button" onClick={() => setPicked(new Set())} className="shrink-0 text-xs font-medium text-accent">
            Put down
          </button>
        </div>
      )}
      <div className="flex flex-col md:flex-row gap-4">
        <div className="min-w-0 md:w-3/4">
          {hasPlan ? (
            <FloorPlan room={space} slug={slug} />
          ) : (
            <div className="rounded-xl border border-dashed border-line dark:border-slate-700 p-6 text-sm text-muted" data-testid="place-no-plan">
              <p className="font-medium text-content dark:text-mortar-100">No floor plan yet: draw your rooms</p>
              <p className="mt-1">{space.name} has no layout to drop things on. Draw it, then come back to place things.</p>
              <Link to={`/locations/${space.id}`} className="mt-3 inline-flex rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5">
                Draw {space.name}
              </Link>
            </div>
          )}
        </div>
        {isDesktop && (
          <aside className="md:w-1/4 md:sticky md:top-20 self-start w-full max-h-[calc(100dvh-7rem)] flex flex-col rounded-xl border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-900/40 p-3">
            {railBody}
          </aside>
        )}
      </div>

      {!isDesktop && (
        <FloatingChrome anchor="bottom" className="rounded-t-2xl border-t border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-2xl">
          <button
            type="button"
            onClick={() => setSheetOpen((v) => !v)}
            aria-expanded={sheetOpen}
            className="w-full flex items-center justify-between gap-2 px-4 py-3 text-sm"
          >
            <span className="font-medium">
              {previewId
                ? pathOf(previewId, byId)
                : picked.size > 0
                  ? `Things to place · ${nameOf([...picked])} picked up`
                  : `Things to place · ${withoutAPlace}`}
            </span>
            {sheetOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
          {sheetOpen && <div className="h-[55dvh] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-col">{railBody}</div>}
        </FloatingChrome>
      )}

      {drag && (
        <PopoverLayer style={{ left: drag.x + 12, top: drag.y + 12 }} className="z-[90] pointer-events-none rounded-lg border border-accent bg-surface dark:bg-slate-900 px-2 py-1 text-sm shadow-lg">
          {nameOf(drag.keys)}
          {over ? <span className="text-accent"> → {pathOf(over, byId)}</span> : null}
        </PopoverLayer>
      )}

      {choose && (
        <Modal open onClose={() => setChoose(null)} title={`Where in ${byId.get(choose.locationId)?.name ?? "it"}?`} subtitle={nameOf(choose.keys)} size={faceOf(choose.locationId) ? "lg" : "sm"}>
          {/* A drawer is not drawn on the room's plan (a map, not an x-ray),
              so a place with a face shows it here: tap drawer 3 itself. */}
          {faceOf(choose.locationId) && (
            <div className="mb-3" data-testid="place-choose-face">
              <PlacingContext.Provider
                value={{
                  ...placing,
                  armed: true,
                  pick: (id, position) => {
                    const keys = choose.keys;
                    setChoose(null);
                    void place(keys, id, position);
                  },
                }}
              >
                <FaceFor room={faceOf(choose.locationId)!} slug={slug} />
              </PlacingContext.Provider>
              <p className="mt-2 text-xs text-muted dark:text-slate-400">Tap the drawer it goes in, or pick from the list.</p>
            </div>
          )}
          <ul className="space-y-1" data-testid="place-choices">
            {placeChoices(choose.locationId, locations).map((c) => (
              <li key={c.id} style={{ paddingLeft: `${c.depth * 1}rem` }}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const keys = choose.keys;
                    setChoose(null);
                    void place(keys, c.id);
                  }}
                  title={c.path}
                  className="w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-subtle dark:hover:bg-slate-800"
                >
                  {c.depth === 0 ? `Right in ${c.name}` : c.name}
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {ask && ask.queue[0] && (
        <SeveralPlacesDialog
          record={ask.queue[0]}
          placeName={pathOf(ask.locationId, byId)}
          busy={busy}
          onAnswer={(a) => void answer(a)}
          onClose={() => {
            const rest = ask.queue.slice(1);
            setAsk(rest.length ? { queue: rest, locationId: ask.locationId } : null);
          }}
        />
      )}
    </PlacingContext.Provider>
  );
}
