// /scan — the inbox review queue, companion app-Photo-Inbox-grade.
//
// Layout (the author's spec, from the companion app gold standard):
//   · ONE narrow header row — title + count + the intake buttons
//     (UPC / Upload / Camera). No dead space, no explainer paragraph;
//     typed-UPC and photo-upload intake live in a modal, the camera is
//     its own full-screen route.
//   · Straight to the matches: each inbox item is an ACCORDION card —
//     the collapsed row is the at-a-glance match (photo, name, one-tap
//     table chips); expanding reveals the full triage surface: catalog
//     photo vs YOUR photo side by side, the AI's reasoning + confidence,
//     sanity-check web links, and the inline confirm form (kind, name,
//     brand, instance fields, qty, location) — no modal hop.
//
// URL intake is deliberately absent: the API stores source_url but
// nothing enriches it yet — a dead control is worse than none.

import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  CheckCircle,
  ChevronDown,
  ExternalLink,
  MapPin,
  RotateCcw,
  ScanLine,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { Modal, useConfirm, useImageSrc, useToast, usePageTitle } from "@cobblr/platform-web";
import {
  type AiStatus,
  ApiError,
  api,
  type Location,
  type ScanInboxItem,
  type ScanCandidate,
  type ScanMenuEntry,
} from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";

/** Base-kind fallback for when the scan menu can't load — the menu
 *  (GET /modules/core-scan/menu) is the real source of truth and lists
 *  the workspace's ACTUAL tables ("Yarn"), not module names. */
const FALLBACK_MENU: ScanMenuEntry[] = [
  { module: "inventory", instance: null, kind: "inventory:part", noun: "part", label: "Inventory part", fields: [] },
  { module: "assets", instance: null, kind: "assets:asset", noun: "asset", label: "Asset", fields: [] },
  { module: "machines", instance: null, kind: "machines:machine", noun: "machine", label: "Machine", fields: [] },
];

/** The confirm endpoint's target_kind is the module's BASE kind. */
function baseKind(module: string): string {
  return module === "assets" ? "asset" : module === "machines" ? "machine" : "part";
}

/** Selection key for a menu entry. */
function entryKey(module: string, instance: string | null): string {
  return `${module}::${instance ?? ""}`;
}

/** Is AI usable for this workspace/user? Cached well beyond a scan
 *  session — availability only changes when someone reconfigures. */
export function useAiStatus(): AiStatus | null {
  const { activeSlug } = useActiveOrg();
  const q = useQuery({
    queryKey: ["ai-status", activeSlug],
    queryFn: () => api.getAiStatus(activeSlug),
    enabled: !!activeSlug,
    staleTime: 5 * 60_000,
  });
  return q.data ?? null;
}

/** The up-front "scans run in basic mode" strip for AI-less instances —
 *  the author's rule: tell the user the experience is degraded BEFORE they hit
 *  it, not after a nameless miss confuses them. */
export function AiOffNotice({ status }: { status: AiStatus | null }) {
  if (!status || status.available) return null;
  return (
    <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm text-content dark:text-mortar-100 flex items-start gap-2">
      <Sparkles size={15} className="text-amber-500 shrink-0 mt-0.5" />
      <div>
        <strong>AI isn't connected — scans run in basic mode.</strong> Known
        barcodes still get a catalog name + photo, but unknown ones won't be
        auto-named, brands won't fill in, and photo-only items won't be
        identified — you'll fill those fields in yourself.{" "}
        {status.reason === "operator_disabled" ? (
          <span className="text-muted dark:text-slate-400">
            (AI is switched off for this whole server.)
          </span>
        ) : (
          <Link to="/configuration/ai" className="text-accent hover:underline">
            Set up a provider →
          </Link>
        )}
      </div>
    </div>
  );
}

/** The at-the-moment-of-pain variant: a nameless miss in the confirm flow. */
export function AiOffMissHint({ status }: { status: AiStatus | null }) {
  if (!status || status.available) return null;
  return (
    <p className="text-xs text-amber-600 dark:text-amber-400">
      No catalog match — and no AI is set up to identify it, so name it
      yourself.{" "}
      {status.reason !== "operator_disabled" && (
        <Link to="/configuration/ai" className="underline">
          Set up AI
        </Link>
      )}{" "}
      {status.reason !== "operator_disabled" && "to have these filled automatically."}
    </p>
  );
}

/** Where scans confirm into — a module instance (e.g. the "yarn" inventory
 *  instance), passed via the URL when you scan from an instance's table. */
export type ScanTarget = { instance: string; module: string; kind: string; label: string };

export function ScanPage() {
  usePageTitle("Scan");
  const { activeSlug } = useActiveOrg();
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

  const qc = useQueryClient();
  const toast = useToast();
  // UPC entry is the only intake that needs a modal (it needs a keyboard
  // anyway); Upload triggers the hidden file input DIRECTLY — no modal hop.
  const [upcOpen, setUpcOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function uploadPhoto(file: File) {
    setUploading(true);
    try {
      const rec = await api.uploadFile(activeSlug, file);
      await api.scanBarcode(activeSlug, { source_kind: "photo", image_file_id: rec.id });
      toast.success("Photo added — AI is identifying it");
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // ?batch=<id> scopes the inbox to one scanner session — the camera's
  // "Done" lands here so you review exactly what you just walked around
  // scanning, not everything ever pending.
  const batchId = params.get("batch");
  const list = useQuery({
    queryKey: ["scan-inbox", activeSlug, batchId],
    queryFn: () =>
      api.listScanInbox(activeSlug, {
        status: "pending",
        batch_id: batchId ?? undefined,
      }),
    enabled: !!activeSlug,
    refetchInterval: 8_000,
  });

  const aiStatus = useAiStatus();
  const items = list.data?.items ?? [];

  // The workspace scan MENU — the same instances-with-fields catalog the
  // matchmaker prompts with. Drives the confirm form's target picker, so
  // the UI never hardcodes module names (core tenet: modules don't know
  // about each other; "Yarn" might be the only table this workspace has).
  const menuQ = useQuery({
    queryKey: ["scan-menu", activeSlug],
    queryFn: () => api.scanMenu(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const menu = menuQ.data?.items ?? null;

  // Location is core-locations' noun, and that capability auto-enables
  // everywhere — so "module enabled" gates nothing. the author's rule: the field
  // exists only when the workspace actually HAS locations (rows).
  const modulesQ = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const locsEnabled = (modulesQ.data?.items ?? []).some(
    (m) => m.name === "core-locations" && m.enabled,
  );
  const locsQ = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug && locsEnabled,
    staleTime: 60_000,
  });
  const hasLocations = locsEnabled && (locsQ.data?.items.length ?? 0) > 0;

  const headerBtn =
    "inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-700 text-sm text-content hover:bg-subtle dark:hover:bg-slate-800/70 px-2.5 py-1.5 transition shrink-0";

  return (
    <div className="space-y-4 max-w-4xl">
      {/* ── the ONE header row: identity + intake. Short word labels;
            compact paddings keep it one row on phones. ──────────────── */}
      <div className="flex items-center gap-2 border-b border-line dark:border-slate-700 pb-2.5 min-w-0">
        <h1 className="text-lg font-semibold text-content dark:text-mortar-100 shrink-0">
          Inbox
        </h1>
        <span className="text-sm text-muted dark:text-slate-400 shrink-0">
          {items.length}
          <span className="hidden sm:inline"> pending</span>
        </span>
        {batchId && (
          <Link
            to="/scan"
            title="Filtered to this scan session — tap to show everything pending"
            className="inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 px-2.5 py-0.5 text-xs text-content dark:text-mortar-100 shrink-0 hover:border-cobble-400"
          >
            session
            <X size={12} className="text-faint" />
          </Link>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setUpcOpen(true)}
          title="Type or scan-gun a UPC"
          className={headerBtn}
        >
          <ScanLine size={15} /> UPC
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title="Upload a photo from this device"
          className={headerBtn + (uploading ? " opacity-50" : "")}
        >
          <Upload size={15} /> Upload
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadPhoto(f);
          }}
        />
        <Link
          to={`/scan/camera${params.toString() ? `?${params}` : ""}`}
          title="Open the full-screen scanner"
          aria-label="Open the camera scanner"
          className="inline-flex items-center rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1.5 transition shrink-0"
        >
          <Camera size={16} />
        </Link>
      </div>

      <AiOffNotice status={aiStatus} />

      {/* When you arrived here from an instance's table ("Scan" on the Yarn
          page), confirms default into that instance. */}
      {target && (
        <div className="rounded-md border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2 text-sm text-content dark:text-mortar-100 flex items-center gap-2">
          <ScanLine size={15} className="text-accent shrink-0" />
          Scanning into <strong>{target.label}</strong> — each confirm adds it to that table.
        </div>
      )}

      {list.isLoading && <div className="text-sm text-faint">loading…</div>}
      {!list.isLoading && items.length === 0 && (
        <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-8 text-center">
          <ScanLine size={28} className="mx-auto text-faint dark:text-slate-600 mb-2" />
          <div className="text-sm text-muted dark:text-slate-400">
            Nothing pending. Open the camera or add a UPC / photo above.
          </div>
        </div>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <InboxCard
            key={item.id}
            item={item}
            pageTarget={target}
            menu={menu}
            hasLocations={hasLocations}
          />
        ))}
      </div>

      {upcOpen && <UpcModal onClose={() => setUpcOpen(false)} />}
    </div>
  );
}

// ── the UPC entry modal — deliberately tiny ───────────────────────────
// One input row + one hint line. Stays open after each add for rapid
// fire (a physical scan gun types a code + Enter; the input refocuses
// after every submit). Upload and Camera act directly from the header —
// this modal exists only because typing needs a keyboard.
function UpcModal({ onClose }: { onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [barcode, setBarcode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const scan = useMutation({
    mutationFn: (value: string) => api.scanBarcode(activeSlug, { barcode: value.trim() }),
    onSuccess: (item) => {
      toast.success(`Scanned: ${item.suggested_name ?? `Barcode ${item.barcode_text}`}`);
      setBarcode("");
      inputRef.current?.focus();
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title="Scan a UPC" size="sm">
      <div className="space-y-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!barcode.trim()) return;
            scan.mutate(barcode.trim());
          }}
          className="flex gap-2 items-center"
        >
          <input
            ref={inputRef}
            type="text"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            placeholder="UPC / EAN / GTIN, then Enter"
            className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 font-mono"
            inputMode="numeric"
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={!barcode.trim() || scan.isPending}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50 shrink-0"
          >
            {scan.isPending ? "…" : "Scan"}
          </button>
        </form>
        <p className="text-xs text-faint dark:text-slate-500">
          Stays open — keep scanning. A scan gun's Enter submits each code.
        </p>
      </div>
    </Modal>
  );
}

// ── one inbox item: an accordion triage card ──────────────────────────
// Collapsed: the at-a-glance match (thumb, name, one-tap table chips).
// Expanded: catalog vs YOUR photo, the AI's reasoning + confidence,
// sanity-check links, and the inline confirm form. A matchmaker chip
// expands straight into that table's form, fields pre-filled.
function InboxCard({
  item,
  pageTarget,
  menu,
  hasLocations,
}: {
  item: ScanInboxItem;
  pageTarget: ScanTarget | null;
  menu: ScanMenuEntry[] | null;
  hasLocations: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  // The expansion's confirm context: which table/instance the form commits
  // into + the matchmaker's pre-filled fields. Keyed into ConfirmForm so
  // switching chips remounts (and so re-seeds) the form.
  const [expanded, setExpanded] = useState(false);
  // The AI box's disclosure — collapsed by default (companion app).
  const [aiOpen, setAiOpen] = useState(false);
  const [formCtx, setFormCtx] = useState<{
    selKey: string | null;
    prefill: Record<string, unknown>;
  }>({
    selKey: pageTarget ? entryKey(pageTarget.module, pageTarget.instance) : null,
    prefill: {},
  });

  function openForm(cand?: ScanCandidate) {
    // No explicit chip and no ?into= target → default to the matchmaker's
    // TOP candidate, fields pre-filled. Expanding a card should land on the
    // AI's best read, not a blank form (the chip tap is a shortcut, not a
    // requirement).
    const pick = cand ?? (pageTarget ? null : (topCand ?? null));
    setFormCtx(
      pick
        ? { selKey: entryKey(pick.module, pick.instance), prefill: pick.fields }
        : {
            selKey: pageTarget ? entryKey(pageTarget.module, pageTarget.instance) : null,
            prefill: {},
          },
    );
    setExpanded(true);
  }

  // The matchmaker is SERVER-OWNED: it runs once at intake (detached) and
  // inline during a rerun. The web never auto-triggers it — a page load
  // costs zero model runs. While the server hasn't stamped matched_at yet,
  // the card shows a passive "AI is reading…" pulse that the 8s list poll
  // resolves on its own.
  const candidates = (item.suggested_candidates ?? []).slice(0, 3);
  const topCand = candidates[0] ?? null;
  const serverMatching =
    item.status === "pending" &&
    !!(item.suggested_name || item.ai_suggested_at) &&
    candidates.length === 0 &&
    !(item.suggested_metadata as { matched_at?: string } | null)?.matched_at;

  const discard = useMutation({
    mutationFn: () => api.discardScanItem(activeSlug, item.id),
    onSuccess: () => {
      toast.success("Discarded.");
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
  });
  // The rerun endpoint runs the WHOLE chain server-side (re-enrich +
  // re-match) before responding — one await, one honest spinner, one toast.
  const rerun = useMutation({
    mutationFn: (hint?: string) => api.rerunScanAi(activeSlug, item.id, hint),
    onSuccess: (fresh) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success(
        fresh.suggested_name
          ? `Lookup updated: ${fresh.suggested_name}`
          : "Re-ran — still no match. Fill it in manually.",
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const rerunning = rerun.isPending;
  const aiWorking = rerun.isPending || serverMatching;

  // Internal /api/v1 file URLs need the Bearer token a bare <img> can't
  // send — useImageSrc blob-loads those; external URLs pass through.
  const catalogUrl = item.catalog_image_file_id
    ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.catalog_image_file_id}/raw?variant=med`
    : (item.catalog_image_url ?? null);
  const yoursUrl = item.image_file_id
    ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.image_file_id}/raw?variant=med`
    : null;
  const catalogImg = useImageSrc(catalogUrl);
  const yoursImg = useImageSrc(yoursUrl);
  const thumb = catalogImg ?? yoursImg;

  const ddg = (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      {/* ── collapsed header row (click = expand) ───────────────────── */}
      <div
        className="p-3 flex items-start gap-3 cursor-pointer"
        onClick={() => (expanded ? setExpanded(false) : openForm())}
      >
        <div className="w-14 h-14 shrink-0 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 flex items-center justify-center">
          {thumb ? (
            <img
              src={thumb}
              alt={item.suggested_name ?? item.barcode_text ?? ""}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <ScanLine size={22} className="text-faint dark:text-slate-600" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {/* The scan usually KNOWS the name before the matchmaker finishes —
              never replace a known title with a status line. Status renders as
              a subtle chip beside it; the pulse only owns the title slot when
              there's genuinely nothing to show yet. */}
          <div className="font-medium text-content dark:text-mortar-100 truncate flex items-center gap-2 min-w-0">
            {item.suggested_name ? (
              <>
                <span className="truncate">{item.suggested_name}</span>
                {(rerunning || serverMatching) && (
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-accent animate-pulse">
                    {rerunning ? "re-running" : "AI reading…"}
                  </span>
                )}
              </>
            ) : rerunning ? (
              <span className="text-accent animate-pulse">Re-running the lookup…</span>
            ) : serverMatching ? (
              <span className="text-accent animate-pulse">AI is reading the details…</span>
            ) : (
              <span className="text-faint italic">Awaiting lookup…</span>
            )}
          </div>
          <div className="text-[11px] font-mono text-faint dark:text-slate-500 truncate">
            {item.barcode_text}
            {item.suggested_manufacturer && ` · ${item.suggested_manufacturer}`}
            {item.suggested_sku && ` · ${item.suggested_sku}`}
            {item.scan_area && ` · 📍${item.scan_area}`}
          </div>
          {!expanded && item.ai_notes && (
            <div className="text-[11px] text-muted mt-0.5 line-clamp-1">{item.ai_notes}</div>
          )}
          {/* Matchmaker chips — the best-fitting tables, their fields
              pre-filled. Tap one to expand straight into that table's form. */}
          {candidates.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {candidates.map((c, i) => (
                <button
                  key={`${c.module}:${c.instance ?? ""}:${i}`}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openForm(c);
                  }}
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
          ) : serverMatching ? (
            <div className="text-[11px] text-faint italic mt-1">finding the best table…</div>
          ) : null}
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => rerun.mutate(undefined)}
            disabled={aiWorking || (!item.barcode_text && !item.image_file_id)}
            className="text-faint hover:text-accent p-1.5 disabled:opacity-30"
            title={aiWorking ? "AI is working…" : "Rerun lookup"}
          >
            <RotateCcw size={14} className={aiWorking ? "animate-spin text-accent" : ""} />
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
            onClick={() => (expanded ? setExpanded(false) : openForm())}
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
            className="text-faint hover:text-accent p-1.5"
          >
            <ChevronDown
              size={16}
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      </div>

      {/* ── expanded triage surface — photos left, intel right (lg+) ── */}
      {expanded && (
        <div className="border-t border-line dark:border-slate-800 p-3 space-y-3 bg-subtle/40 dark:bg-slate-950/40">
          <div className="grid lg:grid-cols-2 gap-3 items-start">
          <div className="space-y-2">
          {/* Catalog vs YOUR photo, side by side (whichever exist). */}
          {(catalogImg || yoursImg) && (
            <div className="flex gap-2">
              {catalogImg && (
                <figure className="flex-1 min-w-0">
                  <div className="rounded-md overflow-hidden border border-line dark:border-slate-700 bg-white dark:bg-slate-800 aspect-square flex items-center justify-center">
                    <img src={catalogImg} alt="catalog" className="w-full h-full object-contain" />
                  </div>
                  <figcaption className="text-[10px] font-mono uppercase tracking-widest text-accent mt-1">
                    ✦ catalog
                  </figcaption>
                </figure>
              )}
              {yoursImg && yoursImg !== catalogImg && (
                <figure className="flex-1 min-w-0">
                  <div className="rounded-md overflow-hidden border border-line dark:border-slate-700 bg-black aspect-square flex items-center justify-center">
                    <img src={yoursImg} alt="your photo" className="w-full h-full object-contain" />
                  </div>
                  <figcaption className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mt-1">
                    yours
                  </figcaption>
                </figure>
              )}
            </div>
          )}
          <PhotoOptions item={item} />
          </div>
          <div className="space-y-3">

          {/* The AI's read — collapsed to its one-line header by default
              (companion app); tap to reveal the reconciliation paragraph + per-field
              chips. The working pulse lives in the always-visible header. */}
          {(item.ai_notes || item.ai_confidence || topCand || aiWorking) && (
            <div className="rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 px-3 py-2">
              <button
                type="button"
                onClick={() => setAiOpen((o) => !o)}
                aria-expanded={aiOpen}
                className="w-full text-left text-xs font-medium text-content dark:text-mortar-100 flex items-center gap-1.5"
              >
                <Sparkles size={12} className={aiWorking ? "text-accent animate-pulse" : "text-accent"} />
                {aiWorking ? (
                  <span className="animate-pulse">
                    {rerun.isPending ? "Re-running the lookup…" : "AI is reading the details…"}
                  </span>
                ) : (
                  "AI suggestion"
                )}
                {!aiWorking && item.ai_confidence && (
                  <span className="text-muted">· {item.ai_confidence}</span>
                )}
                <ChevronDown
                  size={13}
                  className={`ml-auto text-faint transition-transform ${aiOpen ? "rotate-180" : ""}`}
                />
              </button>
              {aiOpen && (<>
              {item.ai_notes && (
                <p className="text-xs text-muted dark:text-slate-400 mt-1">{item.ai_notes}</p>
              )}
              {topCand && Object.keys(topCand.fields).length > 0 && (
                <div className="flex flex-wrap items-center gap-1 mt-1.5">
                  <span className="text-[11px] text-muted dark:text-slate-400">
                    → {topCand.label}:
                  </span>
                  {Object.entries(topCand.fields).map(([k, v]) => (
                    <span
                      key={k}
                      className="inline-flex items-center gap-1 rounded-full bg-surface dark:bg-slate-800 border border-line dark:border-slate-700 px-2 py-0.5 text-[11px] text-content dark:text-mortar-200"
                    >
                      <span className="text-faint">{menuFieldLabel(menu, topCand, k)}</span>
                      {String(v)}
                    </span>
                  ))}
                </div>
              )}
              </>)}
            </div>
          )}

          {/* Identity row: barcode + area + sanity-check links. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {item.barcode_text && (
              <span className="font-mono text-content dark:text-mortar-200 bg-subtle dark:bg-slate-800 rounded px-2 py-0.5">
                ▌▌{item.barcode_text}
              </span>
            )}
            {item.scan_area && (
              <span className="inline-flex items-center gap-1 text-muted dark:text-slate-400">
                <MapPin size={11} className="text-accent" /> {item.scan_area}
              </span>
            )}
            <span className="text-faint">Sanity-check on the web:</span>
            {item.barcode_text && (
              <a
                href={ddg(item.barcode_text)}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline inline-flex items-center gap-0.5"
              >
                barcode <ExternalLink size={10} />
              </a>
            )}
            {item.suggested_name && (
              <a
                href={`${ddg(item.suggested_name)}&iax=images&ia=images`}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline inline-flex items-center gap-0.5"
              >
                name (images) <ExternalLink size={10} />
              </a>
            )}
          </div>

          {/* Research hint — correct the AI and re-run with it. */}
          <HintBox onSubmit={(h) => rerun.mutate(h)} busy={aiWorking} />
          </div>
          </div>

          {/* The inline confirm form — full width below (the right-rail
              attempt collided labels at every width; reverted per the author). */}
          <ConfirmForm
            key={`${item.id}:${formCtx.selKey ?? "auto"}:${item.suggested_name ?? ""}:${item.suggested_manufacturer ?? ""}:${topCand ? topCand.label + JSON.stringify(topCand.fields) + (topCand.quantity ?? "") : "none"}`}
            item={item}
            menu={menu}
            candidates={candidates}
            hasLocations={hasLocations}
            initialKey={formCtx.selKey}
            prefill={formCtx.prefill}
            onDone={() => setExpanded(false)}
            onCancel={() => setExpanded(false)}
          />
        </div>
      )}
    </div>
  );
}

// ── photo options: DDG alternatives for the catalog image ────────────
// The companion app "OTHER PHOTO OPTIONS" strip. Lazy — only fetches once a card
// is expanded; picking one downloads it into core-files as the catalog
// image (SSRF-guarded server-side).
function PhotoOptions({ item }: { item: ScanInboxItem }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const options = useQuery({
    queryKey: ["scan-photo-options", activeSlug, item.id],
    queryFn: () => api.scanPhotoOptions(activeSlug, item.id),
    enabled: !!item.suggested_name || !!item.barcode_text,
    staleTime: 5 * 60_000,
  });
  const pick = useMutation({
    mutationFn: (url: string) => api.setScanCatalogImage(activeSlug, item.id, url),
    onSuccess: () => {
      toast.success("Catalog photo updated");
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const items = options.data?.items ?? [];
  if (options.isLoading) {
    return <div className="text-[11px] text-faint animate-pulse">finding photo options…</div>;
  }
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
        other photo options <span className="text-faint normal-case">· DuckDuckGo</span>
      </div>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1">
        {items.map((o) => (
          <button
            key={o.url}
            type="button"
            disabled={pick.isPending}
            onClick={() => pick.mutate(o.url)}
            title={`${o.title} — ${o.source}`}
            className="w-14 h-14 shrink-0 rounded border border-line dark:border-slate-700 overflow-hidden bg-white hover:border-cobble-400 transition disabled:opacity-50"
          >
            <img src={o.thumb} alt={o.title} className="w-full h-full object-cover" loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── research hint: tell the AI what it got wrong, re-run with it ─────
function HintBox({ onSubmit, busy }: { onSubmit: (hint: string) => void; busy: boolean }) {
  const [hint, setHint] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const h = hint.trim();
        if (!h) return;
        onSubmit(h);
        setHint("");
      }}
      className="rounded-md border border-dashed border-line dark:border-slate-700 p-2"
    >
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1 flex items-center gap-1">
        <Sparkles size={10} className="text-accent" /> research hint
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          placeholder="Anything that helps — a model number, a better name, a correction…"
          className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800"
        />
        <button
          type="submit"
          disabled={!hint.trim() || busy}
          className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50 shrink-0 inline-flex items-center gap-1.5"
        >
          <RotateCcw size={13} className={busy ? "animate-spin" : ""} /> Re-run AI
        </button>
      </div>
    </form>
  );
}

// ── helpers for the AI chips + the menu-driven form ──────────────────

/** Pretty label for a candidate's extracted field — resolved from the
 *  menu entry's field defs, falling back to the raw field name. */
function menuFieldLabel(
  menu: ScanMenuEntry[] | null,
  cand: ScanCandidate,
  fieldName: string,
): string {
  const entry = (menu ?? []).find(
    (m) => m.module === cand.module && (m.instance ?? null) === (cand.instance ?? null),
  );
  return entry?.fields.find((f) => f.name === fieldName)?.label ?? fieldName;
}

// ── the inline confirm form — driven by the workspace scan MENU ───────
// The target picker lists the workspace's ACTUAL tables (instances like
// "Yarn" + each enabled module's default), straight from the same menu
// the matchmaker prompts with — the web hardcodes no module names (core
// tenet). Picking a table renders THAT table's fields, pre-seeded from
// the matchmaker's extraction when a chip routed here.
function ConfirmForm({
  item,
  menu,
  candidates,
  hasLocations,
  initialKey,
  prefill,
  onDone,
  onCancel,
}: {
  item: ScanInboxItem;
  menu: ScanMenuEntry[] | null;
  /** The matchmaker's ranked candidates — switching the Add-to picker to a
   *  table the model already extracted for reseeds its field values. */
  candidates: ScanCandidate[];
  hasLocations: boolean;
  /** Pre-selected menu entry (a matchmaker chip or the ?into= target). */
  initialKey: string | null;
  prefill?: Record<string, unknown>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const { user } = useAuth();
  const isAdmin = !!user?.is_platform_admin;
  const qc = useQueryClient();
  const toast = useToast();
  // Platform-admin only: capture this corrected commit as a matchmaker eval case.
  const [saveEvalCase, setSaveEvalCase] = useState(false);
  const [evalNote, setEvalNote] = useState("");

  const entries = menu && menu.length > 0 ? menu : FALLBACK_MENU;
  // Initial pick: the routed entry if it's on the menu; else the identify's
  // asset/part hint; else the first table.
  const hintedKey = (() => {
    if (initialKey && entries.some((m) => entryKey(m.module, m.instance) === initialKey)) {
      return initialKey;
    }
    const hint =
      (item.suggested_metadata as { entity_type?: string } | null)?.entity_type === "asset"
        ? entries.find((m) => m.module === "assets" && !m.instance)
        : null;
    return entryKey((hint ?? entries[0]!).module, (hint ?? entries[0]!).instance);
  })();
  const [selKey, setSelKey] = useState<string>(hintedKey);
  const entry =
    entries.find((m) => entryKey(m.module, m.instance) === selKey) ?? entries[0]!;

  // The matchmaker candidate for the initial selection: its extraction seeds
  // the fields and its cleaned `name` (retailer noise stripped) beats the raw
  // lookup title.
  const initialCand =
    candidates.find((c) => entryKey(c.module, c.instance) === hintedKey) ?? null;

  const [name, setName] = useState(initialCand?.name ?? item.suggested_name ?? "");
  const aiStatus = useAiStatus();
  // Quantity: the matchmaker's pack-count read ("1 Pack Of 9 Skein" -> 9)
  // beats the row's default 1; an explicitly-set row quantity beats both.
  const initialQty = (() => {
    const cand = candidates.find((c) => entryKey(c.module, c.instance) === hintedKey);
    if ((item.quantity ?? 1) > 1) return item.quantity;
    return cand?.quantity ?? item.quantity ?? 1;
  })();
  const [quantity, setQuantity] = useState<number>(initialQty);
  const [locationId, setLocationId] = useState<string>("");
  // Pre-fill the looked-up brand; the table's own fields (colour, fibre…)
  // seed from the lookup metadata, then the matchmaker's extraction wins.
  const [manufacturer, setManufacturer] = useState(item.suggested_manufacturer ?? "");
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(() => {
    const meta = (item.suggested_metadata as Record<string, unknown> | null) ?? {};
    const seed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (v != null && v !== "" && typeof v !== "object") seed[k] = v;
    }
    // Layering: raw lookup seed < the matchmaker's extraction for this
    // table < an explicit chip prefill (which IS that extraction when the
    // chip routed here).
    return { ...seed, ...(initialCand?.fields ?? {}), ...(prefill ?? {}) };
  });

  const locs = useQuery({
    queryKey: ["locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug && hasLocations,
  });

  // Pre-fill the location from the item's scan_area (the camera stamps the
  // location's NAME — match it back to a row). Only while untouched, so a
  // user's explicit pick is never overwritten when the list loads late.
  const [locTouched, setLocTouched] = useState(false);
  useEffect(() => {
    if (locTouched || locationId || !item.scan_area) return;
    const want = item.scan_area.trim().toLowerCase();
    const hit = (locs.data?.items ?? []).find(
      (l) =>
        l.name.trim().toLowerCase() === want ||
        (l.short_name ?? "").trim().toLowerCase() === want,
    );
    if (hit) setLocationId(hit.id);
  }, [locs.data, item.scan_area, locationId, locTouched]);

  const confirmMut = useMutation({
    mutationFn: () => {
      // `extras.metadata` (the table's fields the user filled — colorway,
      // fibre, …) is deep-merged server-side (keeps the scan's barcode/sku);
      // manufacturer overrides the lookup's.
      const cleanMeta = Object.fromEntries(
        Object.entries(customValues).filter(([, v]) => v != null && v !== ""),
      );
      const extras = {
        ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}),
        ...(Object.keys(cleanMeta).length ? { metadata: cleanMeta } : {}),
      };
      return api.confirmScanItem(activeSlug, item.id, {
        target_module: entry.module,
        target_kind: baseKind(entry.module),
        instance: entry.instance ?? undefined,
        name: name.trim() || (item.suggested_name ?? "Untitled"),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
        location_id: locationId || undefined,
        extras: Object.keys(extras).length ? extras : undefined,
        ...(isAdmin && saveEvalCase
          ? { save_eval_case: true, eval_note: evalNote.trim() || undefined }
          : {}),
      });
    },
    onSuccess: (r) => {
      // Link into the instance when committed into one, else the base module.
      const dest = entry.instance
        ? `/instances/${entry.instance}/parts/${r.created.id}`
        : `/${r.item.target_module === "inventory" ? "inventory/parts" : r.item.target_module + "s"}/${r.created.id}`;
      // NB: toasts render through ToastProvider, which sits ABOVE <BrowserRouter>
      // in App.tsx — so a react-router <Link> here throws ("Cannot destructure
      // 'basename'") and error-boundaries the whole app right after a successful
      // commit. Use a plain <a> with the basename-absolute href instead.
      toast.success(
        <span>
          Created — open{" "}
          <a href={`/w/${activeSlug}${dest}`} className="underline">
            {r.item.suggested_name ?? "the new entity"}
          </a>
        </span> as never,
      );
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // dark: fields sit one step LIGHTER (slate-800) than the slate-900 card +
  // a visible border — they were blending into the background (the author).
  const inputCls =
    "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800";
  const labelCls =
    "text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() && !item.suggested_name) return;
        confirmMut.mutate();
      }}
      className="space-y-3"
    >
      <label className="block">
        <div className={labelCls}>Add to</div>
        <select
          value={selKey}
          onChange={(e) => {
            const k = e.target.value;
            setSelKey(k);
            // Switching to a table the matchmaker already extracted for →
            // merge its field values in (typed values keep winning where
            // the user edited a key the candidate also fills).
            const cand = candidates.find((c) => entryKey(c.module, c.instance) === k);
            if (cand && Object.keys(cand.fields).length) {
              setCustomValues((prev) => ({ ...cand.fields, ...prev }));
            }
          }}
          className={inputCls}
        >
          {entries.map((m) => (
            <option key={entryKey(m.module, m.instance)} value={entryKey(m.module, m.instance)}>
              {m.label}
              {m.instance ? "" : ` (${m.noun})`}
            </option>
          ))}
        </select>
      </label>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block sm:col-span-2">
          <div className={labelCls}>Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={item.suggested_name ?? "(name required)"}
            className={inputCls}
            required
          />
          {!item.suggested_name && <AiOffMissHint status={aiStatus} />}
        </label>

        <label className="block">
          <div className={labelCls}>Brand</div>
          <input
            type="text"
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            placeholder={item.suggested_manufacturer ?? "—"}
            className={inputCls}
          />
        </label>

        {/* The selected TABLE's own fields (from the scan menu — the same
            defs the matchmaker extracts into). Values seed from the lookup
            + the matchmaker; everything stays editable before commit. */}
        {entry.fields.map((f) => (
          <ScanFieldInput
            key={`${entryKey(entry.module, entry.instance)}:${f.name}`}
            def={{
              name: f.name,
              display_label: f.label,
              type: f.type,
              help: f.help ?? null,
              choices: f.choices ?? null,
            }}
            value={customValues[f.name]}
            onChange={(v) => setCustomValues((m) => ({ ...m, [f.name]: v }))}
          />
        ))}

        <label className="block">
          <div className={labelCls}>Quantity</div>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className={inputCls}
          />
        </label>
        {/* Location is core-locations' noun — hidden unless that module is
            actually enabled here (modules never assume each other). */}
        {hasLocations && (
          <label className="block">
            <div className={labelCls}>Location (optional)</div>
            <select
              value={locationId}
              onChange={(e) => {
                setLocTouched(true);
                setLocationId(e.target.value);
              }}
              className={inputCls}
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
        )}
      </div>
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
              className={inputCls}
            />
          )}
          <p className="text-[10px] text-muted dark:text-slate-400">
            Records this corrected commit (input + menu + your route/fields) as a golden case
            for the prompt-eval harness.
          </p>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
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
  );
}

/** The minimal field-def shape the input renderer needs — satisfied by
 *  both platform field defs and the scan menu's trimmed fields. */
interface FieldDefLike {
  name: string;
  display_label: string;
  type: string;
  help?: string | null;
  choices?: string[] | null;
}

/** Does this field want a colour swatch? The platform has no dedicated
 *  color TYPE — bundles ship them as text whose help says "pick a
 *  hex/colour for the swatch" (yarn's `color`). Render those with a
 *  native picker + the text in sync; the matchmaker is prompted to fill
 *  them with CSS hex codes. */
function wantsSwatch(def: FieldDefLike): boolean {
  return (
    def.type === "text" &&
    (/hex|swatch/i.test(def.help ?? "") || def.name === "color" || def.name === "colour")
  );
}
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** One custom-field input on the scan-confirm form, by the field def's type
 *  (dropdown for choices, checkbox/number/date/text otherwise) + its help. */
function ScanFieldInput({
  def,
  value,
  onChange,
}: {
  def: FieldDefLike;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const s = value == null ? "" : String(value);
  if (wantsSwatch(def)) {
    const hex = HEX_RE.test(s.trim()) ? s.trim() : null;
    return (
      <label className="block">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
          {def.display_label}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={hex ?? "#888888"}
            onChange={(e) => onChange(e.target.value)}
            title={hex ?? "pick a colour"}
            className="h-8 w-10 shrink-0 rounded border border-line dark:border-slate-600 bg-transparent p-0.5 cursor-pointer"
          />
          <input
            type="text"
            value={s}
            onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
            placeholder="#6F8FAF"
            className="flex-1 min-w-0 px-2 py-1.5 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800"
          />
        </div>
        {def.help ? (
          <p className="text-[11px] text-faint dark:text-slate-500 leading-snug mt-1">{def.help}</p>
        ) : null}
      </label>
    );
  }
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
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800"
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
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800"
        />
      )}
      {help}
    </label>
  );
}
