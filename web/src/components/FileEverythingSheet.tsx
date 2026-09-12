// File everything: the plan first, then the press.
//
// One button files a whole inbox (or one receipt session), adding to what you
// already have rather than making a second one. The route decided how since
// 2026-08-24; no surface ever called it (#2444), so the changelog promised a
// button that did not exist. This is the button.
//
// The plan is three piles the person reads before anything is written:
//   Added to what you have  - a single barcode or name match, "+2 to Cucumbers"
//   Filed as new            - nothing like it yet, into the table it names
//   Left for you            - ambiguous or nameless, with the reason
// Confirm sends exactly the first two piles' ids and what was shown for each;
// the route acts only on those, and skips one whose plan changed since the
// look. The 10 to 20 second write shows as work, not a hang, and the result
// carries per-line Undo (the ordinary unconfirm, which now takes an attach's
// quantity back off the record) and Undo all.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, Loader2, RotateCcw } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { ApiError, api, type AutofileDryRun, type AutofilePlanLine, type AutofileResult } from "../lib/api";
import { lineFor, pilesFrom, seenFrom, type Piles } from "../lib/autofilePiles";
import { LocationTreePicker } from "./LocationTreePicker";

const TZ = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

function Pile({
  title,
  hint,
  lines,
  open,
  onToggle,
  tone,
  trailing,
}: {
  title: string;
  hint: string;
  lines: AutofilePlanLine[];
  open: boolean;
  onToggle: () => void;
  tone: "good" | "new" | "left";
  trailing?: (p: AutofilePlanLine) => React.ReactNode;
}) {
  const color =
    tone === "good"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "new"
        ? "text-accent dark:text-cobble-300"
        : "text-amber-700 dark:text-amber-300";
  return (
    <section className="rounded-md border border-line dark:border-slate-700">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`text-xs font-medium ${color}`}>{title}</span>
        <span className="text-xs text-muted">{lines.length}</span>
        <span className="flex-1 text-[11px] text-faint truncate">{hint}</span>
        <ChevronDown size={14} className={`shrink-0 text-faint transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && lines.length > 0 && (
        <ul className="border-t border-line dark:border-slate-700 divide-y divide-line dark:divide-slate-800">
          {lines.map((p) => {
            const l = lineFor(p);
            return (
              <li key={p.itemId} className="px-3 py-1.5 text-sm flex items-baseline gap-2">
                <span className="text-content dark:text-mortar-100 truncate min-w-0">{l.name}</span>
                <span className="text-xs text-muted truncate min-w-0 flex-1">{l.detail}</span>
                {trailing?.(p)}
              </li>
            );
          })}
        </ul>
      )}
      {open && lines.length === 0 && <div className="px-3 pb-2 text-xs text-faint italic">none</div>}
    </section>
  );
}

export function FileEverythingSheet({
  slug,
  batchId,
  defaultLocationId,
  scope,
  onClose,
  onFiled,
}: {
  slug: string;
  /** One receipt session, or the whole pending inbox when absent. */
  batchId?: string | null;
  /** Where "filed as new" lands unless changed: the session's place. */
  defaultLocationId?: string | null;
  /** What the title calls the scope: "this receipt" or "the inbox". */
  scope: string;
  onClose: () => void;
  /** After a confirm (and after each undo), so the inbox behind refreshes. */
  onFiled?: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [openPiles, setOpenPiles] = useState<Record<"attach" | "create" | "skip", boolean>>({ attach: true, create: true, skip: false });
  const [locationId, setLocationId] = useState<string | null>(defaultLocationId ?? null);
  const [result, setResult] = useState<AutofileResult | null>(null);
  const [undone, setUndone] = useState<Set<string>>(new Set());

  const plan = useQuery({
    queryKey: ["autofile-plan", slug, batchId ?? "all"],
    queryFn: () => api.autofileScan(slug, { ...(batchId ? { batch_id: batchId } : {}) }) as Promise<AutofileDryRun>,
    staleTime: 0,
    gcTime: 0,
  });
  const piles: Piles = useMemo(() => pilesFrom(plan.data?.plans ?? []), [plan.data]);
  const toFile = piles.attach.length + piles.create.length;

  const confirm = useMutation({
    mutationFn: () => {
      const { item_ids, seen } = seenFrom(piles);
      return api.autofileScan(slug, {
        confirm: true,
        ...(batchId ? { batch_id: batchId } : {}),
        item_ids,
        seen,
        ...(locationId ? { location_id: locationId } : {}),
        ...(TZ() ? { timezone: TZ() } : {}),
      }) as Promise<AutofileResult>;
    },
    onSuccess: (r) => {
      setResult(r);
      toast.success(r.message);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      onFiled?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const undoOne = useMutation({
    mutationFn: (itemId: string) => api.unconfirmScanItem(slug, itemId),
    onSuccess: (r, itemId) => {
      setUndone((s) => new Set(s).add(itemId));
      if (r.note) toast.success(r.note);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      onFiled?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const [undoingAll, setUndoingAll] = useState(false);
  const undoAll = async () => {
    if (!result) return;
    setUndoingAll(true);
    let n = 0;
    for (const id of result.filed) {
      if (undone.has(id)) continue;
      try {
        await api.unconfirmScanItem(slug, id);
        setUndone((s) => new Set(s).add(id));
        n++;
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : String(e));
      }
    }
    setUndoingAll(false);
    toast.success(`Put ${n} back in the inbox.`);
    void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
    onFiled?.();
  };

  const filedLines = result ? [...piles.attach, ...piles.create].filter((p) => result.filed.includes(p.itemId)) : [];

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={result ? "Filed" : `File everything in ${scope}`}
      subtitle={
        result
          ? result.message
          : plan.data
            ? `${plan.data.more ? `The first ${plan.data.total ?? plan.data.plans.length} of more` : `${plan.data.total ?? plan.data.plans.length} waiting`}. Nothing is written until you confirm.${plan.data.more ? " Run it again for the rest." : ""}`
            : undefined
      }
      footer={
        result ? (
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={undoingAll || filedLines.every((p) => undone.has(p.itemId))}
              onClick={() => void undoAll()}
              className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <RotateCcw size={14} /> {undoingAll ? "Putting back…" : "Undo all"}
            </button>
            <button type="button" onClick={onClose} className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm">
              Done
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm">
              Cancel
            </button>
            <button
              type="button"
              disabled={!plan.data || toFile === 0 || confirm.isPending}
              onClick={() => confirm.mutate()}
              className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium"
            >
              {confirm.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Filing {toFile}… this takes a moment
                </>
              ) : (
                <>Confirm: file {toFile}</>
              )}
            </button>
          </div>
        )
      }
    >
      {plan.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted py-6 justify-center">
          <Loader2 size={16} className="animate-spin" /> Checking what you already have…
        </div>
      )}
      {plan.isError && <div className="text-sm text-ember-600 dark:text-ember-400">Could not plan: {plan.error instanceof ApiError ? plan.error.message : String(plan.error)}</div>}
      {plan.data && !result && (
        <div className="space-y-2">
          <Pile
            title="Added to what you have"
            hint="one clear match: the count goes up, no second record"
            lines={piles.attach}
            open={openPiles.attach}
            onToggle={() => setOpenPiles((o) => ({ ...o, attach: !o.attach }))}
            tone="good"
          />
          <Pile
            title="Filed as new"
            hint="nothing like it yet: a new record in the table it names"
            lines={piles.create}
            open={openPiles.create}
            onToggle={() => setOpenPiles((o) => ({ ...o, create: !o.create }))}
            tone="new"
          />
          {piles.create.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted px-1">
              <span className="shrink-0">New ones go to</span>
              <LocationTreePicker value={locationId} onChange={setLocationId} size="sm" placeholder="no location" className="min-w-0 flex-1" />
            </div>
          )}
          <Pile
            title="Left for you"
            hint="ambiguous or unnamed: untouched, with the reason"
            lines={piles.skip}
            open={openPiles.skip}
            onToggle={() => setOpenPiles((o) => ({ ...o, skip: !o.skip }))}
            tone="left"
          />
        </div>
      )}
      {result && (
        <div className="space-y-2">
          {(result.installed?.length ?? 0) > 0 && (
            <div className="text-xs text-muted px-1">
              Installed on the way: {result.installed!.map((b) => b.label).join(", ")}. Undo puts a line back; the table stays.
            </div>
          )}
          {filedLines.length > 0 && (
            <ul className="rounded-md border border-line dark:border-slate-700 divide-y divide-line dark:divide-slate-800">
              {filedLines.map((p) => {
                const l = lineFor(p);
                const isUndone = undone.has(p.itemId);
                return (
                  <li key={p.itemId} className={`px-3 py-1.5 text-sm flex items-baseline gap-2 ${isUndone ? "opacity-50" : ""}`}>
                    <CheckCircle2 size={13} className={`shrink-0 self-center ${isUndone ? "text-faint" : "text-emerald-500"}`} />
                    <span className="text-content dark:text-mortar-100 truncate min-w-0">{l.name}</span>
                    <span className="text-xs text-muted truncate min-w-0 flex-1">{isUndone ? "back in the inbox" : l.detail}</span>
                    {!isUndone && (
                      <button
                        type="button"
                        disabled={undoOne.isPending || undoingAll}
                        onClick={() => undoOne.mutate(p.itemId)}
                        className="shrink-0 text-xs text-accent hover:underline disabled:opacity-50"
                      >
                        Undo
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {result.changed.length > 0 && (
            <div className="rounded-md border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs">
              <div className="font-medium text-amber-800 dark:text-amber-200">Changed since you looked, so left alone:</div>
              <ul className="mt-1 space-y-0.5 text-amber-900/80 dark:text-amber-100/80">
                {result.changed.map((c) => (
                  <li key={c.itemId}>
                    {c.name ?? "(unnamed)"}: was going to be {c.was === "attach" ? "added to something" : c.was === "create" ? "filed as new" : "left"}, now would be {c.now === "attach" ? "added to something" : c.now === "create" ? "filed as new" : "left"}.
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.failures.length > 0 && (
            <div className="rounded-md border border-ember-300 dark:border-ember-700/60 px-3 py-2 text-xs text-ember-700 dark:text-ember-300">
              {result.failures.length} could not be filed and stay in the inbox.
            </div>
          )}
          {piles.skip.length > 0 && (
            <div className="text-xs text-muted px-1">
              {piles.skip.length} left for you in the inbox, as planned.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
