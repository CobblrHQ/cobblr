// "What's still here?": a stocktake of one place. Everything still listed in
// it, newest first; the person ticks what is really there, sets what is left
// of a part-used one, and the rest is marked gone in one batch with one Undo.
// Nothing changes until the button that says how many will go is pressed.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EntityPhoto, Modal, NumberField, useConfirm, usePhotoPick, useRunAction, useToast } from "@cobblr/platform-web";
import { countOf, quantityWithUnit } from "@cobblr/platform-contract/plural";
import { ApiError, api, type StocktakeItem } from "../../lib/api";

/** "Keep 6, mark 31 gone": what pressing the button will do. */
export function stocktakeSentence(keep: number, gone: number): string {
  return `Keep ${keep}, mark ${gone} gone`;
}

export function WhatsStillHereButton({ slug, placeId, placeName }: { slug: string; placeId: string; placeName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-accent hover:underline" data-testid="whats-still-here">
        What's still here?
      </button>
      {open && <WhatsStillHereSheet slug={slug} placeId={placeId} placeName={placeName} onClose={() => setOpen(false)} />}
    </>
  );
}

function WhatsStillHereSheet({ slug, placeId, placeName, onClose }: { slug: string; placeId: string; placeName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // PRESS-ARGS: the sheet passes the place, the ticked ids, the counts and, when everything goes, the count said back; Undo passes the stocktake it made.
  const runAction = useRunAction();
  const q = useQuery({ queryKey: ["stocktake-scope", slug, placeId], queryFn: () => api.stocktakeScope(slug, placeId) });
  // Ticked = still here; the number is what is left when it is less than recorded.
  const [here, setHere] = useState<Map<string, number | null>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const label = q.data?.label ?? placeName;
  // A starting list from one photo: what it ticked, and what it saw that is
  // not on record here, offered to add, never added on its own.
  const [reading, setReading] = useState(false);
  const [fromPhoto, setFromPhoto] = useState<{ seen: number; ticked: number; unmatched: Array<{ name: string; qty: number }> } | null>(null);
  // The collection most of this place's things are in: where something new seen here goes.
  const instance = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
    const kind = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return kind ? (kind === "inventory:part" ? "inventory" : kind.split(":")[0]!) : null;
  }, [items]);

  const readPhoto = async (file: File) => {
    setError(null);
    setReading(true);
    try {
      const uploaded = await api.uploadFile(slug, file, { camera: true });
      const r = await api.stocktakePhoto(slug, placeId, uploaded.id);
      setHere((m) => {
        const next = new Map(m);
        for (const hit of r.matched) if (!next.has(hit.id)) next.set(hit.id, null);
        return next;
      });
      setFromPhoto({ seen: r.seen, ticked: r.matched.length, unmatched: r.unmatched });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  };

  const photo = usePhotoPick((files) => {
    if (files[0]) void readPhoto(files[0]);
  }, { title: "One shelf or one door", label: "Photo of one shelf or door" });

  const addSeen = async (seen: { name: string; qty: number }) => {
    if (!instance) return;
    setError(null);
    try {
      // Every argument a new thing here needs: its collection, its name, this
      // place and how many the photo saw.
      const res = await runAction({ actionId: "inventory:create-item", args: { instance, name: seen.name, location_id: placeId, qty: seen.qty } });
      const id = (res.result as { item_id?: string } | null)?.item_id;
      await q.refetch();
      if (id) setHere((m) => new Map(m).set(id, null));
      setFromPhoto((f) => (f ? { ...f, unmatched: f.unmatched.filter((u) => u !== seen) } : f));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    }
  };

  const { keep, counted, gone } = useMemo(() => {
    const keep: string[] = [];
    const counted: Array<{ id: string; qty: number }> = [];
    const gone: StocktakeItem[] = [];
    for (const i of items) {
      if (!here.has(i.id)) gone.push(i);
      else {
        const left = here.get(i.id);
        if (left === 0) gone.push(i);
        else if (left != null && left < i.qty) counted.push({ id: i.id, qty: left });
        else keep.push(i.id);
      }
    }
    return { keep, counted, gone };
  }, [items, here]);
  const kept = keep.length + counted.length;

  const toggle = (id: string) =>
    setHere((m) => {
      const next = new Map(m);
      if (next.has(id)) next.delete(id);
      else next.set(id, null);
      return next;
    });

  const run = async () => {
    setError(null);
    let confirmCount: number | undefined;
    if (kept === 0) {
      const ok = await confirm({
        title: `Nothing left in ${label}?`,
        message: `This marks all ${countOf(gone.length, "thing")} in ${label} gone. You can undo it straight after.`,
        confirmLabel: `Mark all ${gone.length} gone`,
        destructive: true,
      });
      if (!ok) return;
      confirmCount = gone.length;
    }
    setBusy(true);
    try {
      // Every argument the action needs is here: the place, the ticked ids,
      // the counts, and the number said back when everything goes.
      const res = await runAction({
        actionId: "inventory:stocktake",
        args: { scope: { place_id: placeId }, keep, counted, ...(confirmCount !== undefined ? { confirm_count: confirmCount } : {}) },
      });
      const data = (res.result as { data?: { stocktake_id?: string } } | null)?.data;
      const refresh = () => {
        void qc.invalidateQueries({ queryKey: ["stock-at", slug] });
        void qc.invalidateQueries({ queryKey: ["stocktake-scope", slug] });
        void qc.invalidateQueries({ queryKey: ["location-contents", slug] });
      };
      refresh();
      onClose();
      toast.action(`Took stock of ${label}: ${kept} kept, ${gone.length} marked gone.`, {
        actionLabel: "Undo",
        onAction: async () => {
          if (!data?.stocktake_id) return;
          try {
            // The one argument the undo needs is the stocktake this run made.
            await runAction({ actionId: "inventory:undo-stocktake", args: { stocktake_id: data.stocktake_id } });
            refresh();
            toast.success(`Put ${label} back as it was.`);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        },
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`What's still in ${label}?`} size="md">
      <div className="space-y-3" data-testid="whats-still-here-sheet">
        <p className="text-sm text-muted dark:text-slate-400">
          Tick what is really there. Everything you leave unticked is marked gone, not finished or thrown out, so nothing is learned from it.
        </p>
        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {photo.input}
            <button type="button" disabled={reading || busy} onClick={photo.pick} className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm disabled:opacity-50">
              {reading ? "Reading the photo…" : "Start from a photo"}
            </button>
            <span className="text-xs text-muted dark:text-slate-400">One shelf or one door at a time works best.</span>
          </div>
        )}
        {fromPhoto && (
          <div className="rounded-md border border-line dark:border-slate-700 px-3 py-2 text-sm space-y-1" data-testid="stocktake-from-photo">
            <p className="text-content dark:text-slate-200">
              The photo ticked {countOf(fromPhoto.ticked, "thing")} of the {fromPhoto.seen} it saw. Check the list: nothing changes until you press the button.
            </p>
            {fromPhoto.unmatched.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted dark:text-slate-400">Seen, not listed here:</span>
                {fromPhoto.unmatched.map((u) =>
                  instance ? (
                    <button key={u.name} type="button" onClick={() => void addSeen(u)} className="rounded-full border border-line dark:border-slate-600 px-2 py-0.5 text-xs hover:text-accent">
                      Add {u.name}
                    </button>
                  ) : (
                    <span key={u.name} className="text-xs">
                      {u.name}
                    </span>
                  ),
                )}
              </div>
            )}
          </div>
        )}
        {q.isLoading ? (
          <p className="text-sm text-muted">Reading what is listed here…</p>
        ) : q.isError ? (
          <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">
            {q.error instanceof Error ? q.error.message : "Could not read what is listed here."}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">Nothing is listed in {label}.</p>
        ) : (
          <ul className="max-h-[55vh] overflow-y-auto divide-y divide-line dark:divide-slate-800 rounded-md border border-line dark:border-slate-700">
            {items.map((i) => {
              const ticked = here.has(i.id);
              return (
                <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="stocktake-row">
                  <label className="flex flex-1 min-w-0 basis-48 items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={ticked} onChange={() => toggle(i.id)} aria-label={`${i.title} is still here`} />
                    <EntityPhoto src={i.image_path} alt={i.title} size={32} className="rounded-md bg-subtle text-muted shrink-0" />
                    <span className={`min-w-0 truncate text-sm ${ticked ? "text-content dark:text-mortar-100" : "text-muted dark:text-slate-400 line-through"}`}>{i.title}</span>
                  </label>
                  {ticked ? (
                    <span className="inline-flex items-center gap-2 text-xs text-muted dark:text-slate-400">
                      <NumberField
                        value={here.get(i.id) ?? i.qty}
                        min={0}
                        onChange={(n) => setHere((m) => new Map(m).set(i.id, n))}
                        label={`How many ${i.title} are left`}
                        className="w-16 rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-right text-sm text-content dark:text-mortar-100"
                      />
                      {i.unit && i.unit !== "each" ? `${i.unit} left` : "left"}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-faint">
                      {quantityWithUnit(i.qty, i.unit)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">
            {error}
          </p>
        )}
        {items.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-sm text-content dark:text-slate-200" data-testid="stocktake-preview">
              {stocktakeSentence(kept, gone.length)}
            </span>
            <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy || (gone.length === 0 && counted.length === 0)}
              className="rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium"
            >
              {gone.length ? `Mark ${gone.length} gone` : "Save counts"}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
