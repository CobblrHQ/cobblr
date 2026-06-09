// /scan — barcode entry + inbox review queue.
//
// v0.1 keeps it simple: a single page with two stacked sections.
// Top: barcode entry (manual type or paste — camera capture in a
// follow-up). Bottom: inbox queue with one row per pending item,
// suggested-name + catalog image + a "Confirm" affordance that
// opens a modal to pick target kind + location and commit.

import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  Check,
  CheckCircle,
  RotateCcw,
  ScanLine,
  Sparkles,
  X,
} from "lucide-react";
import { Modal, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";
import {
  ApiError,
  api,
  type Location,
  type PlatformFieldDef,
  type ScanInboxItem,
  type ScanCandidate,
} from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";

const TARGET_KINDS = [
  { module: "inventory", kind: "part", label: "Inventory part" },
  { module: "assets", kind: "asset", label: "Asset" },
  { module: "machines", kind: "machine", label: "Machine" },
] as const;

/** Where scans confirm into — a module instance (e.g. the "yarn" inventory
 *  instance), passed via the URL when you scan from an instance's table. */
export type ScanTarget = { instance: string; module: string; kind: string; label: string };

/** A matchmaker candidate → a confirm target. Instance candidates route into
 *  that table (with its fields); a generic candidate (instance null) returns
 *  null so the modal falls back to its base-module picker. The target's `kind`
 *  is the base kind (drives qty-field mapping), NOT the field-def entity kind. */
function candidateToTarget(c: ScanCandidate): ScanTarget | null {
  if (!c.instance) return null;
  const kind = c.module === "assets" ? "asset" : c.module === "machines" ? "machine" : "part";
  return { instance: c.instance, module: c.module, kind, label: c.label };
}

export function ScanPage() {
  usePageTitle("Scan");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();
  const into = params.get("into");
  const target: ScanTarget | null = into
    ? {
        instance: into,
        module: params.get("module") ?? "inventory",
        kind: params.get("kind") ?? "part",
        label: params.get("label") ?? into,
      }
    : null;
  const [barcode, setBarcode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<{
    item: ScanInboxItem;
    target: ScanTarget | null;
    prefill: Record<string, unknown>;
  } | null>(null);

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
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
          <ScanLine size={20} className="text-accent" />
          Scan
        </h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} pending
        </span>
        <div className="flex-1" />
        <Link
          to={`/scan/camera${params.toString() ? `?${params}` : ""}`}
          className="inline-flex items-center gap-2 rounded border border-line dark:border-slate-700 text-sm text-content hover:bg-subtle dark:hover:bg-slate-800/70 px-3 py-1.5 transition"
        >
          <Camera size={14} /> Use camera
        </Link>
      </div>

      {/* When you arrived here from an instance's table ("Scan" on the Yarn
          page), confirms default into that instance. */}
      {target && (
        <div className="rounded-md border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2 text-sm text-content dark:text-mortar-100 flex items-center gap-2">
          <ScanLine size={15} className="text-accent shrink-0" />
          Scanning into <strong>{target.label}</strong> — each confirm adds it to that table.
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!barcode.trim()) return;
          scan.mutate(barcode.trim());
        }}
        className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex gap-2 items-center"
      >
        <ScanLine size={18} className="text-faint" />
        <input
          ref={inputRef}
          type="text"
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          placeholder="Type or scan a UPC / EAN / GTIN, then Enter"
          className="flex-1 px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 font-mono"
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

      <p className="text-xs text-muted dark:text-slate-400">
        Lookups hit Open Products Facts + upcitemdb in parallel, with a
        web-search + AI fallback when the catalogs miss. Hits land here with a
        suggested name + brand + catalog photo; the best-fitting tables show as
        one-tap chips. Use the camera for the fast blocking scan flow.
      </p>

      {list.isLoading && <div className="text-sm text-faint">loading…</div>}
      {!list.isLoading && items.length === 0 && (
        <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-8 text-center">
          <ScanLine size={28} className="mx-auto text-faint dark:text-slate-600 mb-2" />
          <div className="text-sm text-muted dark:text-slate-400">
            Nothing pending. Scan a barcode above to start.
          </div>
        </div>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            onConfirm={(cand) =>
              setConfirming(
                cand
                  ? { item, target: candidateToTarget(cand), prefill: cand.fields }
                  : { item, target, prefill: {} },
              )
            }
          />
        ))}
      </div>

      {confirming && (
        <ConfirmModal
          item={confirming.item}
          target={confirming.target}
          prefill={confirming.prefill}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function InboxRow({
  item,
  onConfirm,
}: {
  item: ScanInboxItem;
  onConfirm: (candidate?: ScanCandidate) => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  // Matchmaker: once an item is identified, find the best table(s) for it +
  // fill their fields. Fire once per item (guarded) — the list polls every 8s,
  // so without the guard this would re-run forever.
  const matchTried = useRef(false);
  const match = useMutation({
    mutationFn: () => api.matchScanItem(activeSlug, item.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] }),
  });
  useEffect(() => {
    if (
      !matchTried.current &&
      item.suggested_name &&
      (item.suggested_candidates?.length ?? 0) === 0 &&
      !match.isPending
    ) {
      matchTried.current = true;
      match.mutate();
    }
  }, [item.suggested_name, item.suggested_candidates, match]);

  const candidates = (item.suggested_candidates ?? []).slice(0, 3);

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
      : item.catalog_image_url
        ? item.catalog_image_url
        : // Photo scans have no catalog image — show the user's own photo.
          item.image_file_id
          ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.image_file_id}/raw?variant=thumb`
          : null;

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 flex items-start gap-3">
      <div className="w-16 h-16 shrink-0 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 flex items-center justify-center">
        {catalogImg ? (
          /* Catalog image; remote URL during enrichment, local file once downloaded */
          <img
            src={catalogImg}
            alt={item.suggested_name ?? item.barcode_text ?? ""}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <ScanLine size={24} className="text-faint dark:text-slate-600" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-content dark:text-mortar-100 truncate">
          {item.suggested_name ?? (
            <span className="text-faint italic">Awaiting lookup…</span>
          )}
        </div>
        <div className="text-[11px] font-mono text-faint dark:text-slate-500 truncate">
          {item.barcode_text}
          {item.suggested_manufacturer && ` · ${item.suggested_manufacturer}`}
          {item.suggested_sku && ` · ${item.suggested_sku}`}
        </div>
        {item.ai_notes && (
          <div className="text-[11px] text-muted mt-0.5">{item.ai_notes}</div>
        )}
        {/* Matchmaker chips — the best-fitting tables, with their fields
            pre-filled. Tap one to confirm straight into that table. */}
        {candidates.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {candidates.map((c, i) => (
              <button
                key={`${c.module}:${c.instance ?? ""}:${i}`}
                type="button"
                onClick={() => onConfirm(c)}
                title={
                  Object.keys(c.fields).length
                    ? `Fills: ${Object.entries(c.fields).map(([k, v]) => `${k}=${v}`).join(", ")}`
                    : `Add to ${c.label}`
                }
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition border ${
                  i === 0
                    ? "bg-cobble-600 hover:bg-cobble-700 text-white border-cobble-600"
                    : "bg-subtle dark:bg-slate-800 hover:bg-line dark:hover:bg-slate-700 text-content dark:text-mortar-200 border-line dark:border-slate-700"
                }`}
              >
                <Sparkles size={11} />
                {c.label}
                {Object.keys(c.fields).length > 0 && (
                  <span className="opacity-70">· {Object.keys(c.fields).length} fields</span>
                )}
              </button>
            ))}
          </div>
        ) : match.isPending ? (
          <div className="text-[11px] text-faint italic mt-1">finding the best table…</div>
        ) : null}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => rerun.mutate()}
          disabled={rerun.isPending || !item.barcode_text}
          className="text-faint hover:text-accent p-1.5 disabled:opacity-30"
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
          className="text-faint hover:text-ember-500 p-1.5"
          title="Discard"
        >
          <X size={14} />
        </button>
        <button
          type="button"
          onClick={() => onConfirm()}
          className="inline-flex items-center gap-1 bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium rounded px-3 py-1.5 transition"
          title="Confirm manually (pick the table yourself)"
        >
          <Check size={13} /> Confirm
        </button>
      </div>
    </div>
  );
}

function ConfirmModal({
  item,
  target,
  prefill,
  onClose,
}: {
  item: ScanInboxItem;
  target: ScanTarget | null;
  prefill?: Record<string, unknown>;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const { user } = useAuth();
  const isAdmin = !!user?.is_platform_admin;
  const qc = useQueryClient();
  const toast = useToast();
  // Platform-admin only: capture this corrected commit as a matchmaker eval case.
  const [saveEvalCase, setSaveEvalCase] = useState(false);
  const [evalNote, setEvalNote] = useState("");
  // Default the kind: a preset instance target wins; else the identify's
  // asset/part hint (asset → assets:asset, else inventory:part).
  const hintedKey = target
    ? `${target.module}:${target.kind}`
    : (item.suggested_metadata as { entity_type?: string } | null)?.entity_type === "asset"
      ? "assets:asset"
      : `${TARGET_KINDS[0]!.module}:${TARGET_KINDS[0]!.kind}`;
  const [targetKey, setTargetKey] = useState<string>(hintedKey);
  const [name, setName] = useState(item.suggested_name ?? "");
  const [quantity, setQuantity] = useState<number>(item.quantity ?? 1);
  const [locationId, setLocationId] = useState<string>("");
  // Pre-fill the looked-up brand onto the instance's Brand field; the rest of
  // the instance's fields (colour, fibre…) are shown for the user to fill.
  const [manufacturer, setManufacturer] = useState(item.suggested_manufacturer ?? "");
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(() => {
    // Seed any custom field whose name matches a key the lookup returned…
    const meta = (item.suggested_metadata as Record<string, unknown> | null) ?? {};
    const seed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (v != null && v !== "" && typeof v !== "object") seed[k] = v;
    }
    // …then let the matchmaker's table-specific field values win (colorway,
    // fibre, weight…) — these are the companion app-grade extraction.
    return { ...seed, ...(prefill ?? {}) };
  });

  // When scanning INTO an instance, fetch its fields so the confirm form shows
  // them (Brand pre-filled from the lookup; the rest editable) — companion app-grade.
  const instanceKind = target ? `${target.instance}:item` : "";
  const fieldDefs = useQuery({
    queryKey: ["platform-field-defs", activeSlug, instanceKind],
    queryFn: () => api.listFieldDefs(activeSlug, instanceKind),
    enabled: !!target,
    staleTime: 60_000,
  });
  const customFields = (fieldDefs.data?.items ?? []).filter((d) => d.type !== "computed");

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
      // When committing into an instance, carry the edited Brand + the
      // instance's custom fields. extras.metadata is deep-merged server-side
      // (keeps the scan's barcode/sku); manufacturer overrides the lookup's.
      const cleanMeta = Object.fromEntries(
        Object.entries(customValues).filter(([, v]) => v != null && v !== ""),
      );
      const extras = target
        ? {
            ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}),
            ...(Object.keys(cleanMeta).length ? { metadata: cleanMeta } : {}),
          }
        : undefined;
      return api.confirmScanItem(activeSlug, item.id, {
        target_module,
        target_kind,
        instance: target?.instance,
        name: name.trim() || (item.suggested_name ?? "Untitled"),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
        location_id: locationId || undefined,
        extras: extras && Object.keys(extras).length ? extras : undefined,
        ...(isAdmin && saveEvalCase
          ? { save_eval_case: true, eval_note: evalNote.trim() || undefined }
          : {}),
      });
    },
    onSuccess: (r) => {
      // Link into the instance when scanned into one, else the base module.
      const dest = target
        ? `/instances/${target.instance}/parts/${r.created.id}`
        : `/${r.item.target_module === "inventory" ? "inventory/parts" : r.item.target_module + "s"}/${r.created.id}`;
      // NB: toasts render through ToastProvider, which sits ABOVE <BrowserRouter>
      // in App.tsx — so a react-router <Link> here throws ("Cannot destructure
      // 'basename'") and error-boundaries the whole app right after a successful
      // commit. Use a plain <a> with the basename-absolute href instead.
      toast.success(
        <span>
          Created — open{" "}
          <a href={`/w/${activeSlug}${dest}`} className="underline" onClick={onClose}>
            {r.item.suggested_name ?? "the new entity"}
          </a>
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
              className="max-h-32 rounded border border-line dark:border-slate-700"
            />
          </div>
        )}
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
            barcode
          </div>
          <div className="font-mono text-sm text-content dark:text-mortar-100">
            {item.barcode_text ?? "—"}
          </div>
        </div>
        {target ? (
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
              Adding to
            </div>
            <div className="text-sm text-content dark:text-mortar-100 font-medium">→ {target.label}</div>
          </div>
        ) : (
          <label className="block">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
              Target kind
            </div>
            <select
              value={targetKey}
              onChange={(e) => setTargetKey(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            >
              {TARGET_KINDS.map((k) => (
                <option key={`${k.module}:${k.kind}`} value={`${k.module}:${k.kind}`}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
            Name
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={item.suggested_name ?? "(name required)"}
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            required
            autoFocus
          />
        </label>

        {/* Scanning into an instance → show its fields. Brand pre-fills from the
            lookup; the rest (colour, fibre…) are yours to fill before commit. */}
        {target && (
          <>
            <label className="block">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
                Brand
              </div>
              <input
                type="text"
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                placeholder={item.suggested_manufacturer ?? "—"}
                className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </label>
            {customFields.map((f) => (
              <ScanFieldInput
                key={f.id}
                def={f}
                value={customValues[f.name]}
                onChange={(v) => setCustomValues((m) => ({ ...m, [f.name]: v }))}
              />
            ))}
          </>
        )}

        <label className="block">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
            Quantity
          </div>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
        </label>
        <label className="block">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
            Location (optional)
          </div>
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
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
        {isAdmin && (
          <div className="rounded border border-dashed border-line dark:border-slate-700 p-2 space-y-2">
            <label className="flex items-center gap-2 text-sm text-content cursor-pointer">
              <input
                type="checkbox"
                checked={saveEvalCase}
                onChange={(e) => setSaveEvalCase(e.target.checked)}
              />
              Save as matchmaker eval case
            </label>
            {saveEvalCase && (
              <input
                type="text"
                value={evalNote}
                onChange={(e) => setEvalNote(e.target.value)}
                placeholder="Note / hard-case label (optional)"
                className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            )}
            <p className="text-[10px] text-muted dark:text-slate-400">
              Records this corrected commit (input + menu + your route/fields) as a golden case
              for the prompt-eval harness.
            </p>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
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

/** One custom-field input on the scan-confirm form, by the field def's type
 *  (dropdown for choices, checkbox/number/date/text otherwise) + its help. */
function ScanFieldInput({
  def,
  value,
  onChange,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const s = value == null ? "" : String(value);
  const help = def.help ? (
    <p className="text-[11px] text-faint dark:text-slate-500 leading-snug mt-1">{def.help}</p>
  ) : null;
  if (def.type === "boolean") {
    return (
      <div>
        <label className="flex items-center gap-2 text-sm text-content dark:text-mortar-200 cursor-pointer">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="accent-cobble-500"
          />
          {def.display_label}
        </label>
        {help}
      </div>
    );
  }
  return (
    <label className="block">
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
        {def.display_label}
      </div>
      {def.choices && def.choices.length > 0 ? (
        <select
          value={s}
          onChange={(e) => onChange(e.target.value || null)}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        >
          <option value="">— none —</option>
          {def.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={def.type === "number" ? "number" : def.type === "date" ? "date" : def.type === "url" ? "url" : "text"}
          step={def.type === "number" ? "any" : undefined}
          value={s}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      )}
      {help}
    </label>
  );
}
