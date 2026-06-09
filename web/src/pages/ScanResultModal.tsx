// The blocking result card the camera pops on every successful scan.
//
// companion app-grade in-the-moment flow: scan → BLOCK → show the instant catalog
// match (name + photo, resolved server-side within the 12s budget) + a
// quantity stepper + one-tap routing into the best-fitting table. "Next"
// re-arms the scanner. The item lands in the inbox either way, so desktop
// triage still works; this just lets you set qty / commit on the spot.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle, Minus, Plus, ScanLine, Sparkles, Trash2 } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { ApiError, api, type ScanCandidate, type ScanInboxItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export interface CameraScanTarget {
  into: string | null;
  module: string | null;
  kind: string | null;
  label: string | null;
}

function candidateKind(c: ScanCandidate): string {
  return c.module === "assets" ? "asset" : c.module === "machines" ? "machine" : "part";
}

export function ScanResultModal({
  barcode,
  scanTarget,
  onSaved,
  onClose,
}: {
  barcode: string;
  scanTarget: CameraScanTarget;
  onSaved: (item: ScanInboxItem) => void;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const [item, setItem] = useState<ScanInboxItem | null>(null);
  const [qty, setQty] = useState(1);
  const started = useRef(false);

  // Ingest the barcode on mount → the enriched row comes back (≤12s budget).
  const scan = useMutation({
    mutationFn: () => api.scanBarcode(activeSlug, { barcode }),
    onSuccess: (it) => {
      setItem(it);
      setQty(it.quantity > 0 ? it.quantity : 1);
      onSaved(it);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    scan.mutate();
  }, [scan]);

  // Once identified, ask the matchmaker which table(s) fit — shown as tap chips.
  const match = useQuery({
    queryKey: ["scan-match", activeSlug, item?.id],
    queryFn: () => api.matchScanItem(activeSlug, item!.id),
    enabled: !!item?.id && !!item?.suggested_name,
    staleTime: 60_000,
  });
  const candidates = (match.data?.candidates ?? []).slice(0, 3);

  // Save the quantity (if changed) and re-arm. The row already exists.
  const save = useMutation({
    mutationFn: async () => {
      if (!item) return null;
      if (qty !== item.quantity) {
        return api.updateScanItem(activeSlug, item.id, { quantity: qty });
      }
      return item;
    },
    onSuccess: (updated) => {
      if (updated) onSaved(updated);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // One-tap commit into a table (a matchmaker chip, or the ?into= target).
  const commit = useMutation({
    mutationFn: (opts: { module: string; kind: string; instance?: string; fields?: Record<string, unknown> }) => {
      if (!item) throw new ApiError(400, "no_item", "nothing to commit");
      const extras: Record<string, unknown> = {};
      if (item.suggested_manufacturer) extras.manufacturer = item.suggested_manufacturer;
      if (opts.fields && Object.keys(opts.fields).length) extras.metadata = opts.fields;
      return api.confirmScanItem(activeSlug, item.id, {
        target_module: opts.module,
        target_kind: opts.kind,
        instance: opts.instance,
        name: item.suggested_name ?? `Barcode ${barcode}`,
        quantity: qty > 0 ? qty : 1,
        extras: Object.keys(extras).length ? extras : undefined,
      });
    },
    onSuccess: (r) => {
      const dest = r.item.target_module
        ? `/w/${activeSlug}/${r.item.target_module === "inventory" ? "inventory/parts" : r.item.target_module + "s"}/${r.created.id}`
        : null;
      toast.success(
        (dest ? (
          <span>
            Added — open{" "}
            <a href={dest} className="underline">
              {r.item.suggested_name ?? "the new entity"}
            </a>
          </span>
        ) : (
          `Added ${r.item.suggested_name ?? barcode}`
        )) as never,
      );
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const discard = useMutation({
    mutationFn: () => api.discardScanItem(activeSlug, item!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const looking = scan.isPending || (!!item && !item.suggested_name && !match.isFetched);
  const catalogImg = item?.catalog_image_file_id
    ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.catalog_image_file_id}/raw?variant=thumb`
    : item?.catalog_image_url ?? null;
  const busy = commit.isPending || save.isPending || discard.isPending;

  return (
    <Modal open onClose={onClose} title="Scanned" size="sm">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-16 h-16 shrink-0 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 flex items-center justify-center">
            {catalogImg ? (
              <img src={catalogImg} alt="" className="w-full h-full object-cover" />
            ) : (
              <ScanLine size={24} className="text-faint" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {scan.isPending ? (
              <div className="text-sm text-muted animate-pulse">Looking up…</div>
            ) : (
              <div className="font-medium text-content dark:text-mortar-100">
                {item?.suggested_name ?? <span className="text-faint italic">No catalog match</span>}
              </div>
            )}
            <div className="text-[11px] font-mono text-faint truncate">
              {barcode}
              {item?.suggested_manufacturer && ` · ${item.suggested_manufacturer}`}
            </div>
          </div>
        </div>

        {/* Quantity stepper — set the count once when holding a stack. */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted">quantity</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="rounded-full border border-line dark:border-slate-600 p-1.5 text-content hover:bg-subtle dark:hover:bg-slate-800"
              aria-label="Decrease quantity"
            >
              <Minus size={14} />
            </button>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              className="w-14 text-center px-1 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 font-mono"
            />
            <button
              type="button"
              onClick={() => setQty((q) => q + 1)}
              className="rounded-full border border-line dark:border-slate-600 p-1.5 text-content hover:bg-subtle dark:hover:bg-slate-800"
              aria-label="Increase quantity"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* One-tap routing: the ?into= target first, else matchmaker chips. */}
        {scanTarget.into ? (
          <button
            type="button"
            disabled={!item || busy}
            onClick={() =>
              commit.mutate({
                module: scanTarget.module ?? "inventory",
                kind: scanTarget.kind ?? "part",
                instance: scanTarget.into!,
              })
            }
            className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 disabled:opacity-50"
          >
            <CheckCircle size={15} /> Add to {scanTarget.label ?? scanTarget.into}
          </button>
        ) : candidates.length > 0 ? (
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1.5">
              add to
            </div>
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((c, i) => (
                <button
                  key={`${c.module}:${c.instance ?? ""}:${i}`}
                  type="button"
                  disabled={!item || busy}
                  onClick={() =>
                    commit.mutate({
                      module: c.module,
                      kind: candidateKind(c),
                      instance: c.instance ?? undefined,
                      fields: c.fields,
                    })
                  }
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition border disabled:opacity-50 ${
                    i === 0
                      ? "bg-cobble-600 hover:bg-cobble-700 text-white border-cobble-600"
                      : "bg-subtle dark:bg-slate-800 hover:bg-line dark:hover:bg-slate-700 text-content border-line dark:border-slate-700"
                  }`}
                >
                  <Sparkles size={11} /> {c.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          !looking &&
          item && (
            <div className="text-[11px] text-faint italic">
              {match.isFetching ? "finding the best table…" : "Saved to the inbox — triage it there."}
            </div>
          )
        )}

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            disabled={!item || busy}
            onClick={() => discard.mutate()}
            className="inline-flex items-center gap-1 text-xs text-faint hover:text-ember-500 disabled:opacity-40"
          >
            <Trash2 size={13} /> Discard
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => (item ? save.mutate() : onClose())}
            className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-600 text-content hover:bg-subtle dark:hover:bg-slate-800 text-sm font-medium px-4 py-2"
          >
            <Check size={15} /> Save &amp; next
          </button>
        </div>
      </div>
    </Modal>
  );
}
