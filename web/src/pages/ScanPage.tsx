// /scan — barcode entry + inbox review queue.
//
// v0.1 keeps it simple: a single page with two stacked sections.
// Top: barcode entry (manual type or paste — camera capture in a
// follow-up). Bottom: inbox queue with one row per pending item,
// suggested-name + catalog image + a "Confirm" affordance that
// opens a modal to pick target kind + location and commit.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  Check,
  CheckCircle,
  RotateCcw,
  ScanLine,
  X,
} from "lucide-react";
import { Modal, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";
import {
  ApiError,
  api,
  type Location,
  type ScanInboxItem,
} from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

const TARGET_KINDS = [
  { module: "inventory", kind: "part", label: "Inventory part" },
  { module: "assets", kind: "asset", label: "Asset" },
  { module: "machines", kind: "machine", label: "Machine" },
] as const;

export function ScanPage() {
  usePageTitle("Scan");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [barcode, setBarcode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<ScanInboxItem | null>(null);

  const list = useQuery({
    queryKey: ["scan-inbox", activeSlug],
    queryFn: () => api.listScanInbox(activeSlug, { status: "pending" }),
    enabled: !!activeSlug,
    refetchInterval: 8_000,
  });

  const scan = useMutation({
    mutationFn: (value: string) =>
      api.scanBarcode(activeSlug, { barcode: value.trim() }),
    onSuccess: (item) => {
      const label = item.suggested_name ?? `Barcode ${item.barcode_text}`;
      toast.success(`Scanned: ${label}`);
      setBarcode("");
      inputRef.current?.focus();
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Auto-focus the barcode input. Most physical scanners type a UPC
  // followed by Enter — so the form submits the moment the scanner
  // finishes. The autoFocus prop + manual onSubmit is enough.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100 flex items-center gap-2">
          <ScanLine size={20} className="text-cobble-500" />
          Scan
        </h1>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {items.length} pending
        </span>
        <div className="flex-1" />
        <Link
          to="/scan/camera"
          className="inline-flex items-center gap-2 rounded border border-slate-200 dark:border-slate-700 text-sm text-slate-600 hover:bg-mortar-50 dark:hover:bg-slate-800/70 px-3 py-1.5 transition"
        >
          <Camera size={14} /> Use camera
        </Link>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!barcode.trim()) return;
          scan.mutate(barcode.trim());
        }}
        className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 flex gap-2 items-center"
      >
        <ScanLine size={18} className="text-slate-400" />
        <input
          ref={inputRef}
          type="text"
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          placeholder="Type or scan a UPC / EAN / GTIN, then Enter"
          className="flex-1 px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900 font-mono"
          inputMode="numeric"
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={!barcode.trim() || scan.isPending}
          className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {scan.isPending ? "Looking up…" : "Scan"}
        </button>
      </form>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Lookups hit Open Products Facts + upcitemdb in parallel (both
        keyless free tiers). Hits land here with a suggested name + brand +
        catalog photo; misses become bare barcode rows you can fill in
        manually. The web-search fallback + photo-only path are v0.2.
      </p>

      {list.isLoading && <div className="text-sm text-slate-400">loading…</div>}
      {!list.isLoading && items.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-200 dark:border-slate-700 p-8 text-center">
          <ScanLine size={28} className="mx-auto text-slate-300 dark:text-slate-600 mb-2" />
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Nothing pending. Scan a barcode above to start.
          </div>
        </div>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            onConfirm={() => setConfirming(item)}
          />
        ))}
      </div>

      {confirming && (
        <ConfirmModal item={confirming} onClose={() => setConfirming(null)} />
      )}
    </div>
  );
}

function InboxRow({
  item,
  onConfirm,
}: {
  item: ScanInboxItem;
  onConfirm: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const discard = useMutation({
    mutationFn: () => api.discardScanItem(activeSlug, item.id),
    onSuccess: () => {
      toast.success("Discarded.");
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
  });
  const rerun = useMutation({
    mutationFn: () => api.rerunScanAi(activeSlug, item.id),
    onSuccess: () => {
      toast.success("Re-ran lookup.");
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const catalogImg =
    item.catalog_image_file_id
      ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.catalog_image_file_id}/raw?variant=thumb`
      : item.catalog_image_url;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 flex items-start gap-3">
      <div className="w-16 h-16 shrink-0 rounded-md overflow-hidden border border-slate-200 dark:border-slate-700 bg-mortar-50 dark:bg-slate-800 flex items-center justify-center">
        {catalogImg ? (
          /* Catalog image; remote URL during enrichment, local file once downloaded */
          <img
            src={catalogImg}
            alt={item.suggested_name ?? item.barcode_text ?? ""}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <ScanLine size={24} className="text-slate-300 dark:text-slate-600" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-slate-700 dark:text-mortar-100 truncate">
          {item.suggested_name ?? (
            <span className="text-slate-400 italic">Awaiting lookup…</span>
          )}
        </div>
        <div className="text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate">
          {item.barcode_text}
          {item.suggested_manufacturer && ` · ${item.suggested_manufacturer}`}
          {item.suggested_sku && ` · ${item.suggested_sku}`}
        </div>
        {item.ai_notes && (
          <div className="text-[11px] text-slate-500 mt-0.5">{item.ai_notes}</div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => rerun.mutate()}
          disabled={rerun.isPending || !item.barcode_text}
          className="text-slate-400 hover:text-cobble-600 p-1.5 disabled:opacity-30"
          title="Rerun lookup"
        >
          <RotateCcw size={14} />
        </button>
        <button
          type="button"
          onClick={async () => {
            const ok = await confirm({
              title: "Discard this scan?",
              message: `${item.suggested_name ?? item.barcode_text ?? "Unknown"} will be removed from the inbox.`,
              confirmLabel: "Discard",
              destructive: true,
            });
            if (ok) discard.mutate();
          }}
          className="text-slate-400 hover:text-ember-500 p-1.5"
          title="Discard"
        >
          <X size={14} />
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="inline-flex items-center gap-1 bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium rounded px-3 py-1.5 transition"
        >
          <Check size={13} /> Confirm
        </button>
      </div>
    </div>
  );
}

function ConfirmModal({
  item,
  onClose,
}: {
  item: ScanInboxItem;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [targetKey, setTargetKey] = useState<string>(`${TARGET_KINDS[0]!.module}:${TARGET_KINDS[0]!.kind}`);
  const [name, setName] = useState(item.suggested_name ?? "");
  const [locationId, setLocationId] = useState<string>("");

  const locs = useQuery({
    queryKey: ["locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
  });

  const confirmMut = useMutation({
    mutationFn: () => {
      const [target_module, target_kind] = targetKey.split(":");
      if (!target_module || !target_kind) {
        throw new ApiError(400, "invalid_target", "Pick a target");
      }
      return api.confirmScanItem(activeSlug, item.id, {
        target_module,
        target_kind,
        name: name.trim() || (item.suggested_name ?? "Untitled"),
        location_id: locationId || undefined,
      });
    },
    onSuccess: (r) => {
      toast.success(
        <span>
          Created — open{" "}
          <Link
            to={`/${r.item.target_module === "inventory" ? "inventory/parts" : r.item.target_module + "s"}/${r.created.id}`}
            className="underline"
            onClick={onClose}
          >
            {r.item.suggested_name ?? "the new entity"}
          </Link>
        </span> as never,
      );
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title="Confirm scan" size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() && !item.suggested_name) return;
          confirmMut.mutate();
        }}
        className="space-y-3"
      >
        {item.catalog_image_url && (
          <div className="flex items-center justify-center">
            <img
              src={item.catalog_image_url}
              alt={item.suggested_name ?? ""}
              className="max-h-32 rounded border border-slate-200 dark:border-slate-700"
            />
          </div>
        )}
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-1">
            barcode
          </div>
          <div className="font-mono text-sm text-slate-700 dark:text-mortar-100">
            {item.barcode_text ?? "—"}
          </div>
        </div>
        <label className="block">
          <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-1">
            Target kind
          </div>
          <select
            value={targetKey}
            onChange={(e) => setTargetKey(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          >
            {TARGET_KINDS.map((k) => (
              <option key={`${k.module}:${k.kind}`} value={`${k.module}:${k.kind}`}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-1">
            Name
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={item.suggested_name ?? "(name required)"}
            className="w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
            required
            autoFocus
          />
        </label>
        <label className="block">
          <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400 mb-1">
            Location (optional)
          </div>
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          >
            <option value="">— none —</option>
            {(locs.data?.items ?? []).map((l: Location) => (
              <option key={l.id} value={l.id}>
                {"  ".repeat(l.depth)}
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={confirmMut.isPending || (!name.trim() && !item.suggested_name)}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50 inline-flex items-center gap-1"
          >
            <CheckCircle size={14} />
            {confirmMut.isPending ? "Creating…" : "Confirm"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
