// /locations/:id/plan: plan a layout for a room before anything moves.
//
// A draft (an option, "Option A") holds what would change: a rack moved on
// the floor, a thing put on another shelf, a rack that is not bought yet.
// The real room is untouched until Apply, which does it all as one step with
// one Undo. Options can be kept side by side, compared, and printed to scale
// to take into the room. The drawing is LayoutBoard; the draft lives in
// core-locations (plan-drafts.ts), and the assistant reaches the same drafts
// through its plan-* actions.
// See docs/design-decisions/location-floor-plan.md, "Planning a layout".

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Plus, Printer, Trash2 } from "lucide-react";
import { SearchInput, useConfirm, usePageTitle, useToast } from "@cobblr/platform-web";
import { EMPTY_PLAN_DRAFT, PLANNED_PREFIX, draftSummary, plannedRack, type PlanDraftBody } from "@cobblr/platform-contract/plan-draft";
import { parseOuterSize } from "@cobblr/platform-contract/outer-size";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ApiError, api, type PlanDraft } from "../lib/api";
import { useLayoutBoard } from "../lib/useLayoutBoard";
import { reorderTo, shelfRow } from "../lib/planFit";
import type { Board } from "../lib/layoutBoard";
import { LayoutBoard, startThingDrag, type ThingDrop } from "../components/LayoutBoard";

const countOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The draft after a thing is let go somewhere: on a shelf, every thing on
 *  that shelf gets its spot (the row reads the same however it got there);
 *  on the floor, it stands centred where it was dropped. */
export function dropIntoDraft(body: PlanDraftBody, board: Board, d: ThingDrop, sizeOf: (r: { kind: string; id: string }) => { w_mm: number; d_mm: number; h_mm: number | null } | null): PlanDraftBody {
  const cut = d.key.lastIndexOf(":");
  const kind = d.key.slice(0, cut), id = d.key.slice(cut + 1);
  const things = { ...body.things };
  if (d.into === board.room.id) {
    things[d.key] = { kind, id, into: d.into, x_mm: Math.round(d.x_mm), y_mm: Math.round(d.y_mm) };
    return { ...body, things };
  }
  const shelf = board.racks.flatMap((r) => r.shelves).find((s) => s.id === d.into);
  const size = sizeOf({ kind, id });
  if (!shelf || !size) {
    things[d.key] = { kind, id, into: d.into };
    return { ...body, things };
  }
  const local = { x_mm: 0, y_mm: 0, w_mm: shelf.rect.w_mm, d_mm: shelf.rect.d_mm };
  const others = shelf.things.filter((t) => t.key !== d.key);
  const row = shelfRow(
    local,
    [...others.map((t) => ({ key: t.key, size: t.size!, order: t.rect!.x_mm - shelf.rect.x_mm, name: t.name })), { key: d.key, size: { ...size, unit: "mm" as const }, order: Number.MAX_SAFE_INTEGER, name: "" }],
    null,
  );
  for (const s of reorderTo(row, local, d.key, d.x_mm)) {
    const c = s.key.lastIndexOf(":");
    things[s.key] = { kind: s.key.slice(0, c), id: s.key.slice(c + 1), into: shelf.id, x_mm: s.x_mm, y_mm: 0 };
  }
  return { ...body, things };
}

function PlannedRackForm({ onAdd }: { onAdd: (name: string, size: { w_mm: number; d_mm: number; h_mm: number }, shelves: number) => void }) {
  const [name, setName] = useState("New rack");
  const [size, setSize] = useState("1220 x 610 x 1830 mm");
  const [shelves, setShelves] = useState("5");
  const parsed = parseOuterSize(size);
  const ok = !!parsed?.h_mm && Number(shelves) >= 1;
  return (
    <form
      className="flex flex-wrap items-end gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onAdd(name.trim() || "New rack", { w_mm: parsed!.w_mm, d_mm: parsed!.d_mm, h_mm: parsed!.h_mm! }, Math.round(Number(shelves)));
      }}
    >
      <label className="flex flex-col text-xs text-muted dark:text-slate-400">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} className="mt-0.5 w-36 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-sm text-content dark:text-slate-100" />
      </label>
      <label className="flex flex-col text-xs text-muted dark:text-slate-400">
        Size (W x D x H)
        <input
          value={size}
          onChange={(e) => setSize(e.target.value)}
          className={`mt-0.5 w-44 rounded border px-2 py-1 text-sm bg-surface dark:bg-slate-900 text-content dark:text-slate-100 ${parsed?.h_mm ? "border-line dark:border-slate-600" : "border-ember-500"}`}
        />
      </label>
      <label className="flex flex-col text-xs text-muted dark:text-slate-400">
        Shelves
        <input
          inputMode="numeric"
          value={shelves}
          onChange={(e) => setShelves(e.target.value.replace(/\D/g, ""))}
          className="mt-0.5 w-16 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-sm text-content dark:text-slate-100"
        />
      </label>
      <button type="submit" disabled={!ok} className="rounded bg-cobble-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
        Add planned rack
      </button>
    </form>
  );
}

export function PlanLayoutPage() {
  const { id: roomId = "" } = useParams<{ id: string }>();
  const { activeSlug: slug = "" } = useActiveOrg();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const drafts = useQuery({ queryKey: ["plan-drafts", slug, roomId], queryFn: () => api.planDrafts(slug, roomId), enabled: !!slug && !!roomId });
  const list = useMemo(() => drafts.data?.items ?? [], [drafts.data]);
  const draftId = params.get("draft") ?? list[list.length - 1]?.id ?? null;
  const compareId = params.get("compare");
  const draft = list.find((d) => d.id === draftId) ?? null;
  const other = list.find((d) => d.id === compareId) ?? null;

  // The body being edited: changed here at once, saved behind.
  const [body, setBody] = useState<PlanDraftBody | null>(null);
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!draft) {
      loadedFor.current = null;
      setBody(null);
    } else if (loadedFor.current !== draft.id) {
      loadedFor.current = draft.id;
      setBody(draft.body);
    }
  }, [draft]);
  const save = useMutation({
    mutationFn: (b: PlanDraftBody) => api.planDraftUpdate(slug, draft!.id, { body: b }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["plan-drafts", slug, roomId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const change = (b: PlanDraftBody) => {
    setBody(b);
    save.mutate(b);
  };

  const editable = !!draft && !draft.applied_at;
  const faceH = other ? 220 : 320;
  // Two options side by side: each option's racks share its column's width,
  // so three racks are drawn as big as the column allows.
  const [colW, setColW] = useState(0);
  const colRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = colRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setColW(el.clientWidth));
    ro.observe(el);
    setColW(el.clientWidth);
    return () => ro.disconnect();
  }, [other?.id]);
  const [faceCount, setFaceCount] = useState(1);
  // As many racks to a row as keep each face at least 200 px wide (one on a
  // phone, two or three in a desktop column); the rest wrap below.
  const perRow = Math.max(1, Math.min(faceCount, Math.floor((colW + 16) / 216)));
  const faceW = other && colW > 0 ? Math.floor((colW - (perRow - 1) * 16) / perRow) : undefined;
  const { board, room, placeable, sizeOf, loading } = useLayoutBoard(slug, roomId, body, faceH, faceW);
  const { board: otherBoard } = useLayoutBoard(slug, roomId, other?.body ?? EMPTY_PLAN_DRAFT, faceH, faceW);
  useEffect(() => {
    const n = Math.max(1, ...[board, otherBoard].map((b) => b?.racks.filter((r) => r.face && r.shelves.length).length ?? 1));
    setFaceCount(n);
  }, [board, otherBoard]);
  usePageTitle(room ? `Plan a layout: ${room.name}` : "Plan a layout");

  const pick = (id: string | null, compare?: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("draft", id);
    else next.delete("draft");
    if (compare === null) next.delete("compare");
    else if (compare) next.set("compare", compare);
    setParams(next, { replace: true });
  };
  const create = useMutation({
    mutationFn: (from?: string) => api.planDraftCreate(slug, roomId, from ? { from } : {}),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ["plan-drafts", slug, roomId] });
      pick(d.id, null);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const rename = useMutation({
    mutationFn: (name: string) => api.planDraftUpdate(slug, draft!.id, { name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["plan-drafts", slug, roomId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const discard = useMutation({
    mutationFn: (d: PlanDraft) => api.planDraftDelete(slug, d.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["plan-drafts", slug, roomId] });
      pick(null, null);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const refreshRoom = () => {
    void qc.invalidateQueries({ queryKey: ["plan-drafts", slug, roomId] });
    void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
    void qc.invalidateQueries({ queryKey: ["location-contents", slug] });
    void qc.invalidateQueries({ queryKey: ["kind-list", slug] });
  };
  const undo = useMutation({
    mutationFn: (id: string) => api.planDraftUndo(slug, id),
    onSuccess: (r) => {
      refreshRoom();
      toast.success(r.note);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const apply = useMutation({
    mutationFn: (id: string) => api.planDraftApply(slug, id),
    onSuccess: (r, id) => {
      refreshRoom();
      toast.action(r.note, { actionLabel: "Undo", onAction: () => undo.mutate(id) });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Things not in this room yet, to bring into the draft; sized ones first.
  const [q, setQ] = useState("");
  const tray = useMemo(() => {
    if (!board) return [];
    const inRoom = new Set([board.room.id, ...board.racks.map((r) => r.id), ...board.racks.flatMap((r) => r.shelves.map((s) => s.id))]);
    const needle = q.trim().toLowerCase();
    return placeable
      .filter((r) => !inRoom.has(board.where.get(`${r.kind}:${r.id}`) ?? ""))
      .filter((r) => !needle || r.name.toLowerCase().includes(needle))
      .map((r) => ({ r, size: sizeOf(r) }))
      .sort((a, b) => Number(!!b.size) - Number(!!a.size) || a.r.name.localeCompare(b.r.name))
      .slice(0, 60);
  }, [board, placeable, q, sizeOf]);

  const onDrop = (d: ThingDrop) => {
    if (!editable || !board || !body) return;
    change(dropIntoDraft(body, board, d, sizeOf));
  };
  const onMoveRack = (id: string, rect: { x_mm: number; y_mm: number; w_mm: number; d_mm: number }) => {
    if (!editable || !body) return;
    if (id.startsWith(PLANNED_PREFIX)) {
      const key = id.slice(PLANNED_PREFIX.length);
      change({ ...body, planned: body.planned.map((p) => (p.key === key ? { ...p, rect } : p)) });
    } else change({ ...body, moves: { ...body.moves, [id]: { ...body.moves[id], rect } } });
  };

  const summary = body ? draftSummary(body) : null;
  const askApply = async () => {
    if (!draft || !summary) return;
    const parts = [
      summary.things ? `move ${countOf(summary.things, "thing", "things")}` : null,
      summary.places ? `move ${countOf(summary.places, "rack or shelf", "racks and shelves")}` : null,
      summary.planned ? `make ${countOf(summary.planned, "planned rack", "planned racks")}` : null,
    ].filter(Boolean);
    const ok = await confirm({
      title: `Apply ${draft.name}?`,
      message: parts.length ? `This will ${parts.join(", ")}, as one step you can undo.` : "Nothing in this layout differs from the room.",
      confirmLabel: `Apply ${draft.name}`,
    });
    if (ok) apply.mutate(draft.id);
  };
  const [naming, setNaming] = useState<string | null>(null);
  const [addingRack, setAddingRack] = useState(false);
  const fits = board?.racks.flatMap((r) => r.shelves.filter((s) => s.line).map((s) => ({ rack: r.name, s }))) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <Link to={`/locations/${roomId}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-content dark:text-slate-400">
        <ArrowLeft size={14} /> back to {room?.name ?? "the room"}
      </Link>
      <h1 className="text-2xl font-semibold text-content dark:text-slate-100">Plan a layout{room ? `: ${room.name}` : ""}</h1>

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Layout options">
        {list.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={d.id === draftId}
            onClick={() => pick(d.id)}
            className={`rounded-full border px-3 py-1 text-sm ${d.id === draftId ? "border-accent bg-cobble-600 text-white" : "border-line dark:border-slate-600 text-content dark:text-slate-200 hover:border-accent"}`}
          >
            {d.name}
            {d.applied_at ? " (applied)" : ""}
          </button>
        ))}
        <button type="button" onClick={() => create.mutate(undefined)} className="inline-flex items-center gap-1 rounded-full border border-dashed border-line dark:border-slate-600 px-3 py-1 text-sm text-content dark:text-slate-200 hover:border-accent">
          <Plus size={14} /> {list.length ? "New option" : "Start a layout"}
        </button>
      </div>

      {!drafts.isLoading && !list.length && (
        <p className="text-sm text-muted dark:text-slate-400">
          A layout is a draft of {room?.name ?? "this room"}: move racks on the floor, put things on any shelf, plan a rack you have not bought yet, and nothing real moves until you apply it.
        </p>
      )}

      {draft && (
        <>
          <div
            data-testid="draft-banner"
            className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${draft.applied_at ? "border-line dark:border-slate-600 text-content dark:text-slate-200" : "border-accent bg-cobble-50 dark:bg-cobble-950 text-content dark:text-slate-100"}`}
          >
            {draft.applied_at ? (
              <>
                <span>
                  {draft.name} was applied on {new Date(draft.applied_at).toLocaleDateString()}.
                </span>
                <button type="button" onClick={() => undo.mutate(draft.id)} disabled={undo.isPending} className="rounded border border-line dark:border-slate-600 px-2 py-0.5 text-sm hover:border-accent">
                  Undo it
                </button>
              </>
            ) : (
              <>
                <strong>Draft: nothing has moved yet.</strong>
                <span className="text-muted dark:text-slate-400">Drag racks on the floor and things onto shelves; Apply moves them for real.</span>
              </>
            )}
            <span className="flex-1" />
            {naming === null ? (
              <button type="button" onClick={() => setNaming(draft.name)} className="text-sm text-accent hover:underline">
                Rename
              </button>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (naming.trim()) rename.mutate(naming.trim());
                  setNaming(null);
                }}
              >
                <input aria-label="Layout name" autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} onBlur={() => setNaming(null)} className="w-36 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-0.5 text-sm" />
              </form>
            )}
            <button type="button" onClick={() => create.mutate(draft.id)} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
              <Copy size={13} /> Copy
            </button>
            <a href={`/print/${slug}/locations/${roomId}/layout/${draft.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
              <Printer size={13} /> Print to scale
            </a>
            {/* The option is the chip above; comparing only puts another
                beside it, so it is said as that, never as a second pick. */}
            {other ? (
              <button type="button" onClick={() => pick(draft.id, null)} className="text-sm text-accent hover:underline">
                Stop comparing with {other.name}
              </button>
            ) : (
              list
                .filter((d) => d.id !== draft.id)
                .map((d) => (
                  <button key={d.id} type="button" onClick={() => pick(draft.id, d.id)} className="text-sm text-accent hover:underline">
                    Compare with {d.name}
                  </button>
                ))
            )}
            {!draft.applied_at && (
              <>
                <button
                  type="button"
                  onClick={async () => {
                    if (await confirm({ title: `Discard ${draft.name}?`, message: "Nothing in the room has moved, so nothing changes.", confirmLabel: "Discard", destructive: true })) discard.mutate(draft);
                  }}
                  className="inline-flex items-center gap-1 text-sm text-muted hover:text-ember-600 dark:text-slate-400"
                >
                  <Trash2 size={13} /> Discard
                </button>
                <button type="button" onClick={() => void askApply()} disabled={apply.isPending} className="rounded bg-cobble-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50">
                  Apply {draft.name}
                </button>
              </>
            )}
          </div>

          {loading || !board ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : other && otherBoard ? (
            <div className="grid gap-4 md:grid-cols-2" data-testid="layout-compare">
              <div ref={colRef} className="min-w-0">
                <h2 className="mb-2 text-sm font-semibold text-content dark:text-slate-200">{draft.name}</h2>
                <LayoutBoard board={board} editable={false} onDrop={onDrop} onMoveRack={onMoveRack} maxFaceHeight={220} faceWidth={faceW} />
              </div>
              <div className="min-w-0">
                <h2 className="mb-2 text-sm font-semibold text-content dark:text-slate-200">{other.name}</h2>
                <LayoutBoard board={otherBoard} editable={false} onDrop={onDrop} onMoveRack={onMoveRack} maxFaceHeight={220} faceWidth={faceW} />
              </div>
            </div>
          ) : (
            <>
              {editable && (
                <section className="space-y-2">
                  <h2 className="text-sm font-semibold text-content dark:text-slate-200">Bring things in</h2>
                  <SearchInput value={q} onChange={setQ} placeholder="Find anything" size="sm" />
                  <div className="flex flex-wrap gap-1.5" data-testid="layout-tray">
                    {tray.map(({ r, size }) => (
                      <TrayChip key={`${r.kind}:${r.id}`} name={r.name} sized={!!size} thingKey={`${r.kind}:${r.id}`} onDrop={onDrop} />
                    ))}
                    {tray.length === 0 && <span className="text-xs text-muted">Nothing else to bring in.</span>}
                  </div>
                  {addingRack ? (
                    <PlannedRackForm
                      onAdd={(name, size, shelves) => {
                        const key = `rack-${Math.random().toString(36).slice(2, 8)}`;
                        const at = { x_mm: 0, y_mm: 0 };
                        change({ ...body!, planned: [...body!.planned, ...plannedRack({ key, name, parent: roomId, at, size, shelves })] });
                        setAddingRack(false);
                      }}
                    />
                  ) : (
                    <button type="button" onClick={() => setAddingRack(true)} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
                      <Plus size={13} /> Plan a rack you do not have yet
                    </button>
                  )}
                </section>
              )}
              <LayoutBoard board={board} editable={editable} onDrop={onDrop} onMoveRack={onMoveRack} />
              {fits.length > 0 && (
                <ul data-testid="layout-fits" className="space-y-0.5 text-xs">
                  {[...fits].sort((a, b) => Number(a.s.row!.fits) - Number(b.s.row!.fits)).map(({ rack, s }) => (
                    <li key={s.id} className={s.row!.fits ? "text-muted dark:text-slate-400" : "font-medium text-ember-700 dark:text-ember-300"}>
                      <span className="text-content dark:text-slate-200">
                        {rack}, {s.name}:
                      </span>{" "}
                      {s.line}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function TrayChip({ name, sized, thingKey, onDrop }: { name: string; sized: boolean; thingKey: string; onDrop: (d: ThingDrop) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={ref}
      data-tray-thing={thingKey}
      onPointerDown={(e) => startThingDrag(e, thingKey, ref.current!, onDrop)}
      title={sized ? name : `${name}: no size yet, so it cannot be checked for fit`}
      className="relative cursor-grab touch-none select-none rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-0.5 text-xs text-content dark:text-slate-200"
    >
      {name}
      {!sized && <span className="ml-1 text-faint">(no size)</span>}
    </span>
  );
}
