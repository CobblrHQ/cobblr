// "What's still here?": a stocktake. Everything still listed where it looks
// (a place and the places inside it, the records picked in a table, or a
// collection's things with no place), newest first. The person ticks what is
// really there, by hand, by scanning its barcode or from one photo of a shelf,
// sets what is left of a part-used one, and the rest is marked gone in one
// batch with one Undo. Nothing changes until the button that says how many
// will go is pressed.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EntityPhoto, Modal, NumberField, useConfirm, usePhotoPick, useRunAction, useToast, useUnits } from "@cobblr/platform-web";
import { countOf } from "@cobblr/platform-contract/plural";
import type { StocktakeItem, StocktakeScope } from "../stocktake.js";
import type { InventoryApi } from "./api";

/** "Keep 6, mark 31 gone": what pressing the button will do. */
export function stocktakeSentence(keep: number, gone: number): string {
  return `Keep ${keep}, mark ${gone} gone`;
}

/** Where a scanned code points among the listed rows: the row whose barcode
 *  it is, digits compared without spaces or leading zeros, so a UPC-A read as
 *  an EAN-13 (one leading zero more) still finds its jar. */
export function rowForScan(items: readonly Pick<StocktakeItem, "id" | "barcode">[], scanned: string): string | null {
  const norm = (code: string) => code.replace(/\s+/g, "").replace(/^0+(?=\d)/, "");
  const want = norm(scanned);
  if (!want) return null;
  return items.find((i) => i.barcode && norm(i.barcode) === want)?.id ?? null;
}

const scopeKey = (scope: StocktakeScope) => ("place_id" in scope ? `place:${scope.place_id}` : "ids" in scope ? `ids:${scope.ids.join(",")}` : `unplaced:${scope.instance}`);

export function WhatsStillHereButton({ api, slug, scope, label, fixedLabel, children, className }: {
  api: InventoryApi;
  slug: string;
  scope: StocktakeScope;
  /** What the sheet calls where it looks before the list arrives ("the Fridge"). */
  label: string;
  /** Keep `label` rather than the server's ("the 12 things in What's on hand",
   *  where the server would only know they were picked). */
  fixedLabel?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? "text-xs text-accent hover:underline"} data-testid="whats-still-here">
        {children ?? "What's still here?"}
      </button>
      {open && <WhatsStillHereSheet api={api} slug={slug} scope={scope} label={label} fixedLabel={fixedLabel} onClose={() => setOpen(false)} />}
    </>
  );
}

export function WhatsStillHereSheet({ api, slug, scope, label: initialLabel, fixedLabel, onClose }: { api: InventoryApi; slug: string; scope: StocktakeScope; label: string; fixedLabel?: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // PRESS-ARGS: the sheet passes its scope, the ticked ids, the counts and, when everything goes, the count said back; Undo passes the stocktake it made; Add passes the name, collection and place the photo saw.
  const runAction = useRunAction();
  const units = useUnits();
  const q = useQuery({ queryKey: ["stocktake-scope", slug, scopeKey(scope)], queryFn: () => api.stocktakeScope(scope) });
  // Ticked = still here; the number is what is left when it is less than recorded.
  const [here, setHere] = useState<Map<string, number | null>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState("");
  const [scanned, setScanned] = useState<string | null>(null);
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const label = fixedLabel ? initialLabel : (q.data?.label ?? initialLabel);
  const placeId = "place_id" in scope ? scope.place_id : null;
  // A starting list from one photo: what it ticked, and what it saw that is
  // not on record here, offered to add, never added on its own.
  const [reading, setReading] = useState(false);
  const [fromPhoto, setFromPhoto] = useState<{ seen: number; ticked: number; unmatched: Array<{ name: string; qty: number }> } | null>(null);
  // The collection most of these things are in: where something new seen here goes.
  const instance = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
    const kind = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return kind ? (kind === "inventory:part" ? "inventory" : kind.split(":")[0]!) : null;
  }, [items]);
  const say = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const readPhoto = async (file: File) => {
    if (!placeId) return;
    setError(null);
    setReading(true);
    try {
      const uploaded = await api.uploadPhoto(file);
      const r = await api.stocktakePhoto(placeId, uploaded.id);
      setHere((m) => {
        const next = new Map(m);
        for (const hit of r.matched) if (!next.has(hit.id)) next.set(hit.id, null);
        return next;
      });
      setFromPhoto({ seen: r.seen, ticked: r.matched.length, unmatched: r.unmatched });
    } catch (e) {
      say(e);
    } finally {
      setReading(false);
    }
  };

  const photo = usePhotoPick((files) => {
    if (files[0]) void readPhoto(files[0]);
  }, { title: "One shelf or one door", label: "Photo of one shelf or door" });

  const addSeen = async (seen: { name: string; qty: number }) => {
    if (!instance || !placeId) return;
    setError(null);
    try {
      const res = await runAction({ actionId: "inventory:create-item", args: { instance, name: seen.name, location_id: placeId, qty: seen.qty } });
      const id = (res.result as { item_id?: string } | null)?.item_id;
      await q.refetch();
      if (id) setHere((m) => new Map(m).set(id, null));
      setFromPhoto((f) => (f ? { ...f, unmatched: f.unmatched.filter((u) => u !== seen) } : f));
    } catch (e) {
      say(e);
    }
  };

  /** A scanner types the code and Enter: tick that row, or say it is not listed here. */
  const onScan = () => {
    const code = scan.trim();
    if (!code) return;
    const id = rowForScan(items, code);
    if (id) setHere((m) => (m.has(id) ? m : new Map(m).set(id, null)));
    setScanned(id ? `Ticked ${items.find((i) => i.id === id)!.title}.` : `${code} is not listed in ${label}.`);
    setScan("");
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
    // The server asks for the count said back when everything listed goes, or
    // when what goes is a collection's things with no place (no one place to look in).
    if (gone.length && (kept === 0 || "unplaced" in scope)) {
      const ok = await confirm({
        title: kept === 0 ? `Nothing left in ${label}?` : `Mark ${countOf(gone.length, "thing")} gone?`,
        message: `This marks ${kept === 0 ? "all " : ""}${countOf(gone.length, "thing")} in ${label} gone. You can undo it straight after.`,
        confirmLabel: `Mark ${gone.length} gone`,
        destructive: true,
      });
      if (!ok) return;
      confirmCount = gone.length;
    }
    setBusy(true);
    try {
      const res = await runAction({
        actionId: "inventory:stocktake",
        args: { scope, keep, counted, ...(confirmCount !== undefined ? { confirm_count: confirmCount } : {}) },
      }, { undo: "shown-here" });
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
            await runAction({ actionId: "inventory:undo-stocktake", args: { stocktake_id: data.stocktake_id } }, { undo: "is-undo" });
            refresh();
            toast.success(`Put ${label} back as it was.`);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        },
      });
    } catch (e) {
      say(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={placeId ? `What's still in ${label}?` : `Which of ${label} are still here?`} size="md">
      <div className="space-y-3" data-testid="whats-still-here-sheet">
        <p className="text-sm text-muted dark:text-slate-400">
          Tick what is really there. Everything you leave unticked is marked gone, not finished or thrown out, so nothing is learned from it.
        </p>
        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <form className="flex min-w-0 flex-1 basis-56 items-center gap-2" onSubmit={(e) => { e.preventDefault(); onScan(); }}>
              <input
                value={scan}
                onChange={(e) => setScan(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                aria-label="Scan or type a barcode"
                placeholder="Scan or type a barcode"
                className="min-w-0 flex-1 rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-1.5 text-sm text-content dark:text-mortar-100"
              />
              <button type="submit" className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm">Tick</button>
            </form>
            {placeId && (
              <>
                {photo.input}
                <button type="button" disabled={reading || busy} onClick={photo.pick} className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm disabled:opacity-50">
                  {reading ? "Reading the photo…" : "Start from a photo"}
                </button>
              </>
            )}
          </div>
        )}
        {scanned && <p className="text-sm text-content dark:text-slate-200" role="status" data-testid="stocktake-scanned">{scanned}</p>}
        {placeId && items.length > 0 && !fromPhoto && <p className="text-xs text-muted dark:text-slate-400">A photo works best of one shelf or one door at a time.</p>}
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
                    <span key={u.name} className="text-xs">{u.name}</span>
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
                      {i.unit && i.unit !== "each" ? `${units.unit(i.unit)} left` : "left"}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-faint">{units.format(i.qty, i.unit)}</span>
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
