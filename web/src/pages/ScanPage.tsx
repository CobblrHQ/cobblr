// /scan — the inbox review queue, photo-inbox-grade.
import { createPortal } from "react-dom";
import { FileEverythingSheet } from "../components/FileEverythingSheet";
import { ScanPickerInput, useScanIntake } from "../components/ScanPhotoPicker";
import { SessionReadVerdict } from "../components/SessionReadVerdict";
//
// Layout (the author's spec):
//   · ONE narrow header row — title + count + the intake buttons
//     (UPC / Photo / Camera). No dead space, no explainer paragraph;
//     typed-UPC intake lives in a modal, Photo fires a device file picker
//     (accept=image/*), and the camera is its own full-screen route.
//   · Straight to the matches: each inbox item is an ACCORDION card —
//     the collapsed row is the at-a-glance match (photo, name, one-tap
//     table chips); expanding reveals the full triage surface: catalog
//     photo vs YOUR photo side by side, the AI's reasoning + confidence,
//     sanity-check web links, and the inline confirm form (kind, name,
//     brand, instance fields, qty, location) — no modal hop.
//
// URL intake is deliberately absent: the API stores source_url but
// nothing enriches it yet — a dead control is worse than none.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, ChevronDown, ExternalLink, Image as ImagePlus, LayoutGrid, List, Loader2, MapPin, MonitorSmartphone, Pencil, ReceiptText, RotateCcw, ScanLine, Search, Sparkles, Tag, Trash2, Truck, X, Zap } from "lucide-react";
import { Modal, useToast, usePageTitle, PopoverLayer } from "@cobblr/platform-web";
import { ScanImportModal } from "../components/ScanImportModal";
import { ExportInboxModal } from "../components/ExportInboxModal";
import { } from "../components/CameraCaptureSheet";
import { } from "../panels/registry";
import { LocationChipPicker } from "../components/LocationChipPicker";
import { SessionLocationModal } from "../components/SessionLocationModal";
import { OrganizePlanSheet, SortingPlanView } from "../components/OrganizePlanSheet";
import { OrganizeWalkSheet } from "../components/OrganizeWalkSheet";
import { LiveSortSheet } from "../components/LiveSortSheet";
import { } from "../components/ImageSearchPicker";
import { } from "../components/CropPhotoModal";
import { } from "../components/pastedImage";
import { ReceiptSourceViewer, type ReceiptMoney } from "../components/ReceiptSourceViewer";
import { ReceiptPeek } from "../components/ReceiptPeek";
import { } from "../lib/scanRerun";
import { } from "../lib/identifySentence";
import { } from "../lib/namelessCard";
import { receiptDateWords, type DateReading } from "../lib/receiptDateWords";
import { BinAdjustModal } from "../components/BinAdjustModal";
import { HeaderMenu, MenuHead, MenuItem, MenuNote, MenuSep } from "../components/HeaderMenu";
import { DuplicateRecordsSheet } from "./DuplicateRecordsSheet";
import { ReceiptAddressChip } from "../components/ReceiptAddressChip";
import { classifyOmni, clipboardImages, omniPlaceholder } from "./omniIntake";
import { } from "./scanNameEdit";
import { useAiStatus, AiOffNotice } from "../components/AiStatusNotice";
export { useAiStatus, AiOffNotice } from "../components/AiStatusNotice";
import { decideLocationScan, filingLabel } from "../lib/scanFiling";
import { useHandheld } from "../lib/useHandheld";
import { } from "./ScanItemSheet";
import { ScanInboxMenu } from "./ScanInboxMenu";
import { } from "../lib/scanNotes";
import { } from "../components/ScanCardCommit";
import { } from "../components/ScanToolMenu";
import type { } from "@cobblr/platform-contract/scan-tools";
import { } from "../lib/splitOffer";
import { findCombineClusters } from "../lib/scanCombine";
import {
  
  ApiError,
  api,
  
  type ScanInboxItem,
  type ScanCandidate,
  type ScanMenuEntry,
  type TrackedMatch,
} from "../lib/api";
import { classifyScanPayload } from "../lib/scanPayload";
import { isScanStale, needsScanReview, scanSessionAction } from "@cobblr/platform-contract/scan-triage";
import { displayName } from "@cobblr/platform-contract/display-identity";
import { sessionVerdict, type SessionVerdict } from "@cobblr/platform-contract/scan-session";
import { itemEnriching } from "./scan-status";
import { attachBodyFor, confirmBodyFor, duplicateSummary, isReadyToFile, placementPreview } from "./scanFileAll";
import { resolveInstanceForFiling } from "./scanInstall";
import { arrivalLabel, arrivalOf } from "./scanArrival";
import type { ScanBatchMeta } from "../lib/api";
import { SeriesBanner } from "../components/ScanSeriesBanner";
import { installToastLine } from "../lib/installSummary";
import {
  sessionCategory,
  sessionFilingReadiness,
  sessionLocation,
  categoryAxisKey,
} from "./sessionCategory";
import { usePublishChatContext } from "../lib/chat-context";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";
import { resolveSessionBatch, clearScanSession, readScanSession, isSessionFresh, SESSION_GAP_MS, gapSessionKey } from "../lib/scanSession";
import { tabBrowserId } from "../hooks/useBrowserDrive";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { } from "../lib/useFieldPresentation";
import { } from "../auth/AuthContext";
import { destinationLabel, betterDestination, type DestinationTable } from "@cobblr/platform-contract";
import { InboxCard, GalleryTile } from "./ScanInboxCard";
import { timeAgo, type ScanTarget } from "./scanInboxShared";
export type { ScanTarget } from "./scanInboxShared";

interface ScanDrive {
  /** Has this tab opted in as the driven screen? */
  on: boolean;
  /** True once the drive hub has actually claimed THIS tab (stream connected). */
  active: boolean;
  /** Toggle this tab as the driven screen (non-destructive to a Claude grant). */
  toggle: () => void;
  /** What a scan does this session: `navigate` drives the screen; `print` drops a
   *  label for the scanned entity into the print buffer (D7). */
  mode: "navigate" | "print";
  setMode: (m: "navigate" | "print") => void;
  /** Route a scanned code through /scan-drive (navigate the driven tab / intake). */
  scan: (code: string) => void;
}

/** Own the "drive this screen with scans" opt-in. Reuses the browser-drive hub
 *  built for Claude driving — but does NOT open its own SSE stream: the
 *  always-mounted DriveBanner already runs the stream app-wide (so navigation
 *  survives leaving /scan), keyed by the same per-tab id. Turning on raises the
 *  workspace grant to `navigate` (if it was off), claims THIS tab, and routes
 *  scans through POST /scan-drive. Turning off releases the tab and restores the
 *  grant if WE raised it — never clobbering a separately-enabled Claude grant. */
/** "Today 2:48 PM" / "Yesterday 4:10 PM" / "Jun 21, 2:48 PM" — a scan session's
 *  when, for the grouped-inbox headers. */
function formatSessionTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "Earlier";
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDate = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDate(d, now)) return `Today ${time}`;
  if (sameDate(d, yest)) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/* (day-bucket helpers removed: batch-less history now clusters into
   time-gap pseudo-sessions, so every group is a Session header.) */

type CombineCluster = { items: ScanInboxItem[]; reason: "name" | "barcode" };

/** Was the code READ by a machine (OCR off a photo, or lifted off a receipt)
 *  rather than decoded from the symbol or typed by a person? The server's copy
 *  of this rule, and the vocabulary, live in
 *  modules/core-scan/src/services/barcode-source.ts. */
const machineRead = (src: string | undefined): boolean => src === "ai-photo" || src === "receipt";

const barcodeSourceOf = (it: ScanInboxItem): string | undefined =>
  (it.suggested_metadata as { barcode_source?: string } | null)?.barcode_source;

/** Levenshtein edit distance, capped — OCR barcode errors are 1–2 chars. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n] ?? 99;
}

/** Pair a photo item whose barcode was READ BY AI (OCR) with a DIFFERENT item
 *  whose barcode was SCANNED, when the two codes are within a couple of edits —
 *  "this OCR'd code looks like one you scanned; same thing?". Anchored on the
 *  AI-read side (the uncertain one) to avoid matching two genuinely-different
 *  scanned UPCs. Cluster = [aiItem, scannedItem] (banner renders at the photo). */
function findBarcodeMatchClusters(items: ScanInboxItem[]): ScanInboxItem[][] {
  // Machine-READ on one side, decoded-or-typed on the other. Comparing to
  // "ai-photo" by hand put a code lifted off a RECEIPT on the scanned side, so
  // the pairing would have offered a receipt's own number as corroboration for
  // an OCR'd one - two uncertain codes agreeing with each other.
  const ai = items.filter((i) => i.barcode_text && machineRead(barcodeSourceOf(i)));
  const scanned = items.filter((i) => i.barcode_text && !machineRead(barcodeSourceOf(i)));
  const out: ScanInboxItem[][] = [];
  const used = new Set<string>();
  for (const a of ai) {
    if (used.has(a.id)) continue;
    for (const s of scanned) {
      if (used.has(s.id)) continue;
      // d=0 → OCR nailed it, exactly a barcode you scanned (the strongest match);
      // 1–2 → OCR off by a digit. Both mean "same item, offer to merge". (Identical
      // codes aren't caught by scan-dedup, which only runs at scan time.)
      const d = editDistance(a.barcode_text ?? "", s.barcode_text ?? "");
      if (d <= 2) {
        out.push([a, s]);
        used.add(a.id);
        used.add(s.id);
        break;
      }
    }
  }
  return out;
}

function useScanDrive(slug: string | undefined, batchId: string | undefined): ScanDrive {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [on, setOn] = useState(false);
  const [mode, setModeState] = useState<"navigate" | "print">("navigate");
  const weRaisedGrant = useRef(false);
  const bid = useRef(tabBrowserId());

  // Remember the opt-in + session mode per workspace so a refresh keeps this as
  // the scan screen in the mode you left it.
  useEffect(() => {
    if (!slug) return;
    setOn(localStorage.getItem(`cobblr.scanDrive.${slug}`) === "1");
    setModeState(localStorage.getItem(`cobblr.scanDriveMode.${slug}`) === "print" ? "print" : "navigate");
  }, [slug]);

  const setMode = useCallback(
    (m: "navigate" | "print") => {
      if (!slug) return;
      setModeState(m);
      localStorage.setItem(`cobblr.scanDriveMode.${slug}`, m);
    },
    [slug],
  );

  // Is the hub pointing at THIS tab? Poll status while opted in.
  const statusQ = useQuery({
    queryKey: ["drive-status", slug],
    queryFn: () => api.driveStatus(slug!),
    enabled: !!slug && on,
    refetchInterval: 1500,
  });
  const active = on && statusQ.data?.active === bid.current;

  // Claim this tab as the driven one. The DriveBanner stream needs a beat to
  // connect after the grant flips on, so retry until the hub reports us active.
  useEffect(() => {
    if (!on || !slug || active) return;
    const claim = () => {
      void api.driveTabAccept(slug, bid.current).catch(() => {});
      void qc.invalidateQueries({ queryKey: ["drive-status", slug] });
    };
    claim();
    const iv = setInterval(claim, 1200);
    return () => clearInterval(iv);
  }, [on, slug, active, qc]);

  const toggle = useCallback(() => {
    if (!slug) return;
    if (on) {
      setOn(false);
      localStorage.removeItem(`cobblr.scanDrive.${slug}`);
      void api.driveTabRelease(slug, bid.current).catch(() => {});
      if (weRaisedGrant.current) {
        weRaisedGrant.current = false;
        void api.setDriveGrant(slug, "off").finally(() =>
          qc.invalidateQueries({ queryKey: ["drive-grant", slug] }),
        );
      }
      return;
    }
    // Turn on: raise the grant only if it's currently off (don't downgrade a
    // navigate_observe Claude grant; remember if WE were the one to raise it).
    void api
      .driveGrant(slug)
      .then((g) => {
        if (g.mode === "off") {
          weRaisedGrant.current = true;
          return api.setDriveGrant(slug, "navigate");
        }
        return null;
      })
      .catch(() => null)
      .finally(() => {
        // DriveBanner caches the grant 60s — nudge it to (re)open the stream now.
        void qc.invalidateQueries({ queryKey: ["drive-grant", slug] });
        setOn(true);
        localStorage.setItem(`cobblr.scanDrive.${slug}`, "1");
      });
  }, [slug, on, qc]);

  const scanMut = useMutation({
    mutationFn: async (code: string) => {
      // An explicit ?batch (reviewing one session) wins; otherwise group scans
      // into a time-gap session so the hardware scanner's scans aren't sessionless.
      const sessionBatch =
        batchId ??
        (await resolveSessionBatch(slug!, () =>
          api.createScanBatch(slug!).then((b) => b.id).catch(() => null),
        )) ??
        undefined;
      return api.scanDrive(slug!, code, sessionBatch, mode);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      // Print mode: the scanned entity's label went to the buffer (+ any
      // auto-flush policy). No navigation.
      if (r.action === "print") {
        toast.success(r.queued ? "Label queued to print" : "Scanned");
        return;
      }
      // The driven tab is navigated server-push via the DriveBanner stream. If
      // nothing is driven (single-device, no opt-in), do the friendly thing
      // locally so a QR scan on this very tab still opens the entity.
      if (!r.driven && r.kind === "qr" && r.path) navigate(r.path);
      if (r.kind === "qr") toast.success("Opened from QR");
      else toast.success(r.driven ? "Scanned → sent to your screen" : "Scanned → in the inbox");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return { on, active, toggle, mode, setMode, scan: (code) => scanMut.mutate(code) };
}

/** Second-screen opt-in: make THIS tab follow scans from another device (scan a
 *  bin's QR on your phone → this screen jumps to that bin). It's for a wall
 *  screen / kiosk setup — normal scanning (USB/BT scanner, phone photo, UPC)
 *  already lands items in the inbox below WITHOUT this, and a QR scanned on this
 *  same tab navigates locally regardless. So OFF it's a tiny link, not a card;
 *  it only grows into a status pill once you actually turn it on. */
function ScanDrivePanel({ drive }: { drive: ScanDrive }) {
  const active = drive.active;
  // OFF renders NOTHING: an un-taken offer sat on its own line under the header
  // forever, which is a whole row spent on a feature most sessions never turn on
  // (reported 2026-08-08). The offer lives in the header's ⋯ menu now, under
  // Capture setup with the other setup toggles. Once ON this is live STATUS, and
  // status earns its row.
  if (!drive.on) return null;
  const printing = drive.mode === "print";
  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-2.5 py-1 text-xs">
      {printing ? (
        <Tag size={14} className="text-accent shrink-0" />
      ) : (
        <MonitorSmartphone size={14} className="text-accent shrink-0" />
      )}
      <span className="text-content dark:text-mortar-100">
        {printing
          ? "Scans print a label"
          : active
            ? "This screen follows your scans"
            : "Connecting this screen…"}
      </span>
      {/* Only navigate mode claims/connects a driven tab, so the live pill is
          navigate-only; print just queues server-side. */}
      {!printing && (
        <span
          className={
            "shrink-0 rounded-full px-1.5 py-0.5 " +
            (active
              ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300"
              : "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300")
          }
        >
          {active ? "live" : "…"}
        </span>
      )}
      {/* Session mode: what a scan does (D7). */}
      <span className="inline-flex shrink-0 overflow-hidden rounded border border-cobble-300 dark:border-cobble-700">
        {(["navigate", "print"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => drive.setMode(m)}
            aria-pressed={drive.mode === m}
            className={
              "px-1.5 py-0.5 transition " +
              (drive.mode === m
                ? "bg-accent text-white"
                : "text-muted hover:text-content dark:text-slate-400 dark:hover:text-mortar-100")
            }
          >
            {m === "navigate" ? "Open" : "Print"}
          </button>
        ))}
      </span>
      <button
        type="button"
        onClick={drive.toggle}
        className="shrink-0 text-muted hover:text-content dark:text-slate-400 dark:hover:text-mortar-100 transition"
      >
        Stop
      </button>
    </div>
  );
}

const SHIPMENT_LABEL: Record<string, string> = {
  pre_transit: "Label created",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  exception: "Needs attention",
  unknown: "No information yet",
};

/** Where a committed scan ended up, and whether a better home has appeared since.
 *
 *  This was `-> ${target_kind}` inline, twice, and the two copies had already
 *  drifted: one row said "part" and another "inventory:part" for the same place.
 *  A destination is a table somebody set up, so it is shown by that table's name.
 *
 *  The nudge is deliberately quiet. A scan matched days ago carries the routing
 *  of the workspace AS IT WAS; install a Tea table afterwards and every tea
 *  already filed still points at plain Inventory. Saying so where the mistake is
 *  visible costs nothing and blocks nobody. */
function CommittedDestination({
  item,
  tables,
}: {
  item: { target_kind?: string | null; target_module?: string | null; barcode_text?: string | null; suggested_name?: string | null };
  tables: DestinationTable[];
}) {
  const label = destinationLabel(item.target_kind, tables, item.target_module);
  const better = betterDestination(
    item.suggested_name ?? "",
    item.target_kind,
    tables,
    item.target_module,
  );
  return (
    <div className="text-[10px] font-mono text-faint truncate">
      {label ? `→ ${label}` : ""}
      {item.barcode_text ? ` · ${item.barcode_text}` : ""}
      {better && (
        <span className="ml-1.5 text-ember-600 dark:text-ember-400" title={`This looks like it belongs in ${better.display_name ?? better.instance_name}, which did not exist when this scan was routed. Send it back to re-file it.`}>
          · {better.display_name ?? better.instance_name}?
        </span>
      )}
    </div>
  );
}

/** A session's identity on its header row (icon, label, count). On a phone
 *  it is the tap that folds the session, 44px tall, in place of a chevron
 *  beside a checkbox (the owner, #2982); from sm up it is the heading it
 *  always was. A top-level component, not one made inside the render: a
 *  component type that changes every render remounts its subtree. */
function SessionIdentity({ handheld, expanded, onToggle, className, title, children }: { handheld: boolean; expanded: boolean; onToggle: () => void; className: string; title?: string; children: ReactNode }) {
  return handheld ? (
    <button type="button" onClick={onToggle} aria-expanded={expanded} title={title} className={className}>
      {children}
    </button>
  ) : (
    <span className={className} title={title}>
      {children}
    </span>
  );
}

export function ScanPage() {
  usePageTitle("Scan");
  const { activeSlug, activeOrg } = useActiveOrg();
  // Desk work stays at a desk: the menu rows below that act on files, on
  // many rows, or on settings are not offered on a phone (scan-inbox-device-split.md §3.1).
  const handheld = useHandheld();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // Active filing "bin" — a core-locations node every scan files into until
  // cleared (the active-bin pattern). Stamped as target_location_id on each
  // scan so the item lands pre-filed; persists per workspace in localStorage.
  const fileBinKey = `cobblr.scanFileBin.${activeSlug ?? ""}`;
  const [fileBin, setFileBinState] = useState<string>(() => localStorage.getItem(fileBinKey) ?? "");
  const setFileBin = (v: string) => {
    setFileBinState(v);
    if (v) localStorage.setItem(fileBinKey, v);
    else localStorage.removeItem(fileBinKey);
  };
  // Always-on catalog-photo ranking: the workspace opt-in behind the per-item
  // ✨ Pick best button. Owner/admin only, because turning it on commits the
  // workspace to a vision call per enriched scan. Off unless stored on.
  const canSetPhotoRank = activeOrg?.role === "owner" || activeOrg?.role === "admin";
  const photoRank = useQuery({
    queryKey: ["scan-photo-rank-config", activeSlug],
    queryFn: () => api.getScanPhotoRankConfig(activeSlug),
    enabled: !!activeSlug && canSetPhotoRank,
    staleTime: 5 * 60_000,
  });
  const setPhotoRank = useMutation({
    mutationFn: (enabled: boolean) => api.setScanPhotoRankConfig(activeSlug, enabled),
    onSuccess: (r) => {
      toast.success(
        r.enabled
          ? "Catalog photos will be AI-picked on every scan"
          : "Back to picking photos only when you press Pick best",
      );
      void qc.invalidateQueries({ queryKey: ["scan-photo-rank-config", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // "Same thing twice" - the pairs that already exist. Filing stops NEW ones;
  // nothing but a review removes the ones created before it could.
  const [showDuplicates, setShowDuplicates] = useState(false);
  // File everything: the plan-first bulk filer (#2444). Scoped to one receipt
  // session from its row, or the whole pending inbox from the header menu.
  const [fileEverything, setFileEverything] = useState<{ batchId: string | null; defaultLocationId: string | null; scope: string } | null>(null);
  const glanceCfg = useQuery({
    queryKey: ["scan-glance-config", activeSlug],
    queryFn: () => api.getScanGlanceConfig(activeSlug),
    enabled: !!activeSlug && canSetPhotoRank,
  });
  const setGlanceCfg = useMutation({
    mutationFn: (enabled: boolean) => api.setScanGlanceConfig(activeSlug, enabled),
    onSuccess: (r) => {
      qc.setQueryData(["scan-glance-config", activeSlug], r);
      void qc.invalidateQueries({ queryKey: ["scan-glance-config", activeSlug] });
    },
  });

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
  // Typing a UPC and pasting product URLs used to be a modal each, reached by
  // their own header buttons. Both are now the SAME header box, routed by what
  // was pasted, so the modals and their state are gone. Upload triggers the
  // hidden file input directly - no modal hop.
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const receiptRef = useRef<HTMLInputElement>(null);
  // The intake behind every door on this page (the button, a drop, a paste,
  // the explicit receipt door) is the ONE the dashboard's Photos tile uses
  // too: components/ScanPhotoPicker.tsx. Here uploads join the standing
  // upload session, or the `?batch=` this page is scoped to.
  const aiStatus = useAiStatus();
  const intake = useScanIntake(activeSlug, { session: "inbox", batchId: params.get("batch"), identifyAvailable: aiStatus?.identify_available });
  // ?pick=photos: the PWA shortcut's door (components/AddPhotosTile.tsx).
  const pickPhotos = params.get("pick") === "photos";
  const { uploading, uploadProgress, takeFiles, uploadReceipt, importReceiptFile } = intake;

  // ?reimport_file=<id> — arrived from the "import this copy anyway" link in a
  // duplicate-receipt email. Confirm once (a toast action), never auto-import,
  // then strip the params so a refresh doesn't re-prompt.
  const reimportFile = params.get("reimport_file");
  const reimportRef = params.get("ref");
  const reimportFired = useRef(false);
  useEffect(() => {
    if (!reimportFile || reimportFired.current) return;
    reimportFired.current = true;
    const next = new URLSearchParams(params);
    next.delete("reimport_file");
    next.delete("ref");
    setParams(next, { replace: true });
    toast.action(
      `Re-import this receipt${reimportRef ? ` (#${reimportRef})` : ""} anyway? It looks like one you already imported.`,
      {
        actionLabel: "Import anyway",
        duration: 15000,
        onAction: () =>
          void importReceiptFile(reimportFile, true).catch((e) =>
            toast.error(e instanceof ApiError ? e.message : String(e)),
          ),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reimportFile]);

  // ?batch=<id> scopes the inbox to one scanner session — the camera's
  // "Done" lands here so you review exactly what you just walked around
  // scanning, not everything ever pending.
  const batchId = params.get("batch");
  // Infinite scroll — no hard cap. Load 50 at a time; the sentinel near the
  // bottom pulls the next page. Poll keeps every loaded page fresh for live
  // enrichment updates.
  const list = useInfiniteQuery({
    queryKey: ["scan-inbox", activeSlug, batchId],
    queryFn: ({ pageParam }) =>
      api.listScanInbox(activeSlug, {
        status: "pending",
        batch_id: batchId ?? undefined,
        limit: 50,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: !!activeSlug,
    // Poll fast (2.5s) while ANY loaded row is still enriching so the
    // "finishing… → ready" flip is visible in near-real-time; drop back to 8s
    // once the whole inbox has settled, to stay quiet.
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const busy = pages.some((p) => (p.items ?? []).some((it) => itemEnriching(it)));
      return busy ? 2_500 : 8_000;
    },
  });

  // Flatten the pages, deduped by id — a poll-refetch of page 1 can surface new
  // scans that overlap a later page's stored cursor.
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: ScanInboxItem[] = [];
    for (const p of list.data?.pages ?? []) {
      for (const it of p.items) {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          out.push(it);
        }
      }
    }
    return out;
  }, [list.data]);
  // Session labels by batch id, merged across pages — drives the group header
  // ("Receipt · <vendor>", "emailed <when>") instead of a bare timestamp.
  const batchMeta = useMemo(() => {
    const m: Record<string, ScanBatchMeta> = {};
    for (const p of list.data?.pages ?? []) Object.assign(m, p.batches ?? {});
    return m;
  }, [list.data]);
  // Receipt sessions with no rows: a failed read (a state on the session,
  // never an item) or a read in flight. They are groups of their own below,
  // and a failed one counts as needing a person.
  const rowlessSessions = useMemo(() => {
    const m: Record<string, ScanBatchMeta> = {};
    for (const p of list.data?.pages ?? []) Object.assign(m, p.sessions ?? {});
    return m;
  }, [list.data]);
  const failedSessionCount = useMemo(
    () => Object.values({ ...batchMeta, ...rowlessSessions }).filter((b) => sessionVerdict(b, { pending: 1, ever: 1 }).kind === "failed").length,
    [batchMeta, rowlessSessions],
  );
  const totalPending = list.data?.pages[0]?.total ?? items.length;
  // Pull the next page when the bottom sentinel scrolls into view.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || !hasNextPage) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "600px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  // "Needs review" (a pending item that didn't cleanly resolve — no name yet, a
  // low-trust or rate-limited lookup, or low confidence) and the >2-day stale
  // nudge are defined ONCE, in @cobblr/platform-contract/scan-triage. The list
  // route filters by the same predicates (?triage=…) and Ask Cobb reads the
  // resulting flags off each row, so the count in this header and the answer the
  // assistant gives about the same queue cannot drift apart.
  const needsReview = (it: ScanInboxItem): boolean => needsScanReview(it);
  const [reviewOnly, setReviewOnly] = useState(false);
  const isStale = (it: ScanInboxItem): boolean => isScanStale(it);
  const [staleOnly, setStaleOnly] = useState(false);
  const staleCount = items.filter(isStale).length;
  // A receipt session whose read failed needs a person as much as an item
  // with no name does: it counts here, so the header cannot say "2 to review"
  // over a failed receipt (#2892).
  const reviewCount = items.filter(needsReview).length + failedSessionCount;
  // Tell Ask Cobb what's on this screen, so "what do I have going on?" can
  // reference the backlog without a tool call. The ITEMS themselves are reachable
  // too — the list_scan_inbox tool — so an answer is never limited to this line.
  usePublishChatContext({
    label: "Scan Inbox",
    summary:
      `${totalPending} pending` +
      (staleCount ? `, ${staleCount} waiting 2d+` : "") +
      (reviewCount ? `, ${reviewCount} need review` : ""),
  });
  // Free-text search over the pending queue: tokenized — every word must
  // match somewhere across name / barcode / AI notes / brand / scan area.
  const [searchQ, setSearchQ] = useState("");
  // ONE box: typing filters the list, a pasted code or link offers to ADD.
  // `classifyOmni` is pure + unit-tested because mistaking a search for an add
  // is the one failure that costs the user something (a spurious item to
  // delete); everything ambiguous therefore stays a search.
  const omniIntent = classifyOmni(searchQ);
  // Only PLAIN WORDS filter - a half-typed barcode must not empty the list.
  const searchTokens =
    omniIntent.kind === "text" ? omniIntent.value.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const matchesSearch = (it: ScanInboxItem): boolean => {
    if (!searchTokens.length) return true;
    const hay = [
      it.suggested_name,
      it.barcode_text,
      it.ai_notes,
      it.suggested_manufacturer,
      it.scan_area,
      it.suggested_sku,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return searchTokens.every((tok) => hay.includes(tok));
  };
  const searched = searchTokens.length ? items.filter(matchesSearch) : items;
  const visibleItems = staleOnly
    ? searched.filter(isStale)
    : reviewOnly
      ? searched.filter(needsReview)
      : searched;
  // Gallery ⇄ list — a photo-tile grid for visual triage (persisted).
  const [galleryView, setGalleryView] = useState(() => localStorage.getItem("cobblr-scan-view") === "gallery");
  const toggleGalleryView = () =>
    setGalleryView((v) => {
      localStorage.setItem("cobblr-scan-view", v ? "list" : "gallery");
      return !v;
    });

  // "Looks like the same product" — clusters of pending items (same brand +
  // overlapping names) we can offer to combine into one line. Dismissed clusters
  // (by id-signature) stay hidden for the session.
  const combineClusters = useMemo<CombineCluster[]>(() => {
    const pending = visibleItems.filter((i) => i.status === "pending");
    return [
      ...findCombineClusters(pending).map((items) => ({ items, reason: "name" as const })),
      ...findBarcodeMatchClusters(pending).map((items) => ({ items, reason: "barcode" as const })),
    ];
  }, [visibleItems]);
  const [dismissedCombine, setDismissedCombine] = useState<Set<string>>(new Set());
  const combineMut = useMutation({
    // keepId omitted → the server picks the richest identity (a VIN-decoded
    // vehicle over a photo of it) — smarter than the name-length heuristic.
    mutationFn: ({ ids, keepId }: { ids: string[]; keepId?: string }) =>
      api.combineScanItems(activeSlug, ids, keepId),
    onSuccess: (fresh) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      const qty = Number(fresh.quantity) || 1;
      toast.success(`Combined into one — ${displayName(fresh) ?? "item"}${qty > 1 ? ` ×${qty}` : ""}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Render the combine offer INLINE, right above the cluster's first item (not in
  // a stack at the top) — so it sits with the items it's about.
  const clusterByFirstId = useMemo(() => {
    const m = new Map<string, CombineCluster>();
    for (const c of combineClusters) if (c.items[0]) m.set(c.items[0].id, c);
    return m;
  }, [combineClusters]);
  const combineBanner = (cluster: CombineCluster): ReactNode => {
    const ids = cluster.items.map((c) => c.id);
    const sig = [...ids].sort().join(",");
    if (dismissedCombine.has(sig)) return null;
    // A UNIQUE-tracked kind (declared traits, stamped on the menu — a vehicle, a
    // machine) captured twice is ONE thing seen two ways: the combine merges
    // details (a plate photo's colour + plate into the VIN listing) and must
    // never advertise or produce a ×2.
    const menuEntries = menuQ.data?.items ?? [];
    const clusterKind = cluster.items.map((c) => c.suggested_candidates?.[0]?.kind).find(Boolean);
    const clusterEntry = clusterKind ? menuEntries.find((e) => e.kind === clusterKind) : undefined;
    const isUnique = !!clusterEntry?.unique;
    const clusterNoun = clusterEntry?.noun || "item";
    // Barcode near-match: an OCR-read code that's a couple edits from one you
    // scanned. Keep the SCANNED item (its barcode is authoritative); the photo's
    // OCR'd code is recorded but not trusted.
    if (cluster.reason === "barcode") {
      const [aiItem, scannedItem] = cluster.items;
      if (!aiItem || !scannedItem) return null;
      const totalQty = cluster.items.reduce((n, c) => n + (c.quantity || 1), 0);
      const exact = aiItem.barcode_text === scannedItem.barcode_text;
      // Same barcode, but the two listings can read very differently (a vision
      // name vs a catalog name). Don't auto-pick — show both and let the user
      // choose which one survives. Either way the qty sums and the authoritative
      // scanned barcode is kept (the combine endpoint adopts it).
      const choice = (item: ScanInboxItem, label: string, keepsPhoto: boolean) => (
        <button
          type="button"
          disabled={combineMut.isPending}
          onClick={() => combineMut.mutate({ ids, keepId: item.id })}
          className="flex-1 min-w-0 text-left rounded border border-amber-300 dark:border-amber-700/70 hover:bg-amber-100/60 dark:hover:bg-amber-900/30 px-2.5 py-1.5 disabled:opacity-50"
        >
          <div className="text-[10px] font-mono uppercase tracking-widest text-amber-700 dark:text-amber-500">
            keep {label}
            {keepsPhoto ? " (your photo)" : ""}
          </div>
          <div className="truncate text-sm text-content dark:text-mortar-100">{displayName(item) ?? "(unnamed)"}</div>
        </button>
      );
      return (
        <div className="rounded-lg border border-amber-300 dark:border-amber-700/60 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2.5">
          <div className="flex items-start gap-2 mb-2">
            <ScanLine size={15} className="text-amber-500 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium text-content dark:text-mortar-100">
                Same barcode (<span className="font-mono">{aiItem.barcode_text}</span>){" "}
                {exact ? "as" : "≈ one"} you scanned - looks like the same item.
              </span>
              <span className="text-muted">
                {" "}Which listing to keep?{" "}
                {isUnique
                  ? "One row here with both sets of details and the scanned barcode; the other row goes to Recently deleted. Nothing already filed changes."
                  : `One row here, ×${totalQty}, with the scanned barcode; the other row goes to Recently deleted. Nothing already filed changes.`}
              </span>
            </div>
            <button
              type="button"
              title="Not the same - keep separate"
              onClick={() => setDismissedCombine((s) => new Set(s).add(sig))}
              className="shrink-0 text-faint hover:text-muted p-1"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            {choice(aiItem, "this", true)}
            {choice(scannedItem, "scanned", false)}
          </div>
        </div>
      );
    }
    // Keep the most complete listing: English (ASCII) over localized, then longest.
    const keep = [...cluster.items].sort((a, b) => {
      const aNon = /[^\x00-\x7F]/.test(a.suggested_name ?? "") ? 1 : 0;
      const bNon = /[^\x00-\x7F]/.test(b.suggested_name ?? "") ? 1 : 0;
      if (aNon !== bNon) return aNon - bNon;
      return (b.suggested_name?.length ?? 0) - (a.suggested_name?.length ?? 0);
    })[0];
    if (!keep) return null;
    const totalQty = cluster.items.reduce((n, c) => n + (c.quantity || 1), 0);
    return (
      <div className="rounded-lg border border-amber-300 dark:border-amber-700/60 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2.5 flex items-center gap-3">
        <Sparkles size={15} className="text-amber-500 shrink-0" />
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-medium text-content dark:text-mortar-100">
            {cluster.items.length} items look like the same {isUnique ? clusterNoun : "product"}
          </span>
          <span className="text-muted">
            {" — "}
            {cluster.items.map((c) => displayName(c)).filter(Boolean).join(" · ")}.{" "}
            {/* Say what the tap DOES, not only that it combines (#3009): one
                pending row here, the rest to Recently deleted, nothing
                already filed touched. "Merge" is kept for the open card's
                write into a record you own. */}
            {isUnique
              ? `One row here with all their details? The other${cluster.items.length > 2 ? "s go" : " goes"} to Recently deleted; nothing already filed changes.`
              : `One row here, ×${totalQty}? The other${cluster.items.length > 2 ? "s go" : " goes"} to Recently deleted; nothing already filed changes.`}
          </span>
        </div>
        <button
          type="button"
          disabled={combineMut.isPending}
          onClick={() => combineMut.mutate({ ids, ...(isUnique ? {} : { keepId: keep.id }) })}
          title={`Combines these ${cluster.items.length} pending rows into one row in this inbox${isUnique ? " with all their details" : ` at ×${totalQty}`}. The other ${cluster.items.length > 2 ? "rows go" : "row goes"} to Recently deleted, where it can be restored. Nothing already filed changes.`}
          className="shrink-0 rounded bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {isUnique ? "Combine into one row" : "Combine rows"}
        </button>
        <button
          type="button"
          title="Not the same - keep separate"
          onClick={() => setDismissedCombine((s) => new Set(s).add(sig))}
          className="shrink-0 text-faint hover:text-muted p-1"
        >
          <X size={16} />
        </button>
      </div>
    );
  };

  // Group the inbox for the grouped view. An explicit scan SESSION
  // (scan_batch_id) is one group; loose scans with NO batch group by their
  // calendar DAY. So a hardware-scanner session reads as one timed group, and
  // legacy / un-batched items still read as coherent "Today / Yesterday /
  // <date>" buckets instead of one undifferentiated "No session" lump. Newest
  // group first; items keep their created_at-desc order.
  //
  // SCOPING TO ONE SESSION (?batch) STILL GROUPS. This used to return null
  // there, reasoning that one session needs no separator — true of the
  // grouping, false of the header, because the header is also the session's
  // whole action surface. Returning null dropped the row entirely, so the page
  // you open to work ONE session was the only page with no way to act on it as
  // a session: no select-all (its checkbox is the only one in the file), no
  // Place & file all, no Original / PO# / Tracking # / Re-parse. Filing meant
  // ticking every card by hand (reported 2026-08-15). One group is a fine
  // group; the controls decide for themselves what applies.
  const sessionGroups = useMemo(() => {
    type Group = {
      key: string;
      isBatch: boolean;
      batchId: string | null;
      items: ScanInboxItem[];
      latest: number; // max(created_at) — the session's real scan time
      lastTouched: number; // max(updated_at) — later edits (un-confirm, fixes)
      area: string | null;
      label: string | null; // session title (e.g. "Receipt · Home Depot")
      origin: string | null; // "email" → the header says "emailed <when>"
      sourceFileId: string | null; // the receipt's stored original (View / Re-parse)
      orderRef: string | null; // editable order/invoice number
      trackingNumber: string | null; // set = the parcel is still on its way
      shipmentState: string | null; // where it is, per the last carrier answer
      shipmentDescription: string | null;
      shipmentLocation: string | null;
      /** The receipt read's verdict (platform-contract scan-session): one rule
       *  for the row, the header count and the dashboard. */
      verdict: SessionVerdict;
      /** Which way round the receipt's numeric date was read (#2917). */
      dateReading: DateReading | null;
    };
    const groups: Group[] = [];
    const byBatch = new Map<string, Group>();
    // Batch-less items (older history; intakes that predate batching) cluster
    // into PSEUDO-sessions by time gap — the batch look: every scanning burst is
    // its own session group, whether or not a batch id was minted at the time.
    let pseudo: Group | null = null;
    let pseudoLastT = 0;
    for (const it of visibleItems) {
      // visibleItems arrive newest-first, so the "previous" item is newer.
      const t = Date.parse(it.created_at);
      let g: Group;
      if (it.scan_batch_id) {
        const existing = byBatch.get(it.scan_batch_id);
        if (existing) g = existing;
        else {
          const meta = batchMeta[it.scan_batch_id];
          g = { key: it.scan_batch_id, isBatch: true, batchId: it.scan_batch_id, items: [], latest: 0, lastTouched: 0, area: null, label: meta?.label ?? null, origin: meta?.origin ?? null, sourceFileId: meta?.source_file_id ?? null, orderRef: meta?.order_ref ?? null, trackingNumber: meta?.tracking_number ?? null, shipmentState: meta?.shipment_state ?? null, shipmentDescription: meta?.shipment_description ?? null, shipmentLocation: meta?.shipment_location ?? null, verdict: { kind: "plain" }, dateReading: null };
          byBatch.set(it.scan_batch_id, g);
          groups.push(g);
        }
      } else {
        if (!pseudo || !Number.isFinite(t) || pseudoLastT - t > SESSION_GAP_MS) {
          pseudo = { key: `gap:${it.id}`, isBatch: false, batchId: null, items: [], latest: 0, lastTouched: 0, area: null, label: null, origin: null, sourceFileId: null, orderRef: null, trackingNumber: null, shipmentState: null, shipmentDescription: null, shipmentLocation: null, verdict: { kind: "plain" }, dateReading: null };
          groups.push(pseudo);
        }
        if (Number.isFinite(t)) pseudoLastT = t;
        g = pseudo;
      }
      g.items.push(it);
      if (Number.isFinite(t) && t > g.latest) g.latest = t;
      const u = Date.parse(it.updated_at);
      if (Number.isFinite(u) && u > g.lastTouched) g.lastTouched = u;
      if (!g.area && it.scan_area) g.area = it.scan_area;
    }
    // A gap session is keyed by its OLDEST item once the burst is known: keyed
    // by the newest, the key moved on every new scan and the whole group
    // remounted, dropping every card's pick (#3021, scanSession.ts).
    for (const g of groups) if (!g.isBatch) g.key = gapSessionKey(g.items);
    // The verdict, once the lines are counted; a session in the list whose
    // read failed or is in flight has no lines of its own and is its own group.
    for (const g of groups) {
      if (!g.batchId) continue;
      const meta = batchMeta[g.batchId];
      if (meta) {
        g.verdict = sessionVerdict(meta, { pending: g.items.filter((it) => it.status === "pending").length, ever: g.items.length });
        g.dateReading = { date_convention: meta.date_convention ?? null, date_decided_by: meta.date_decided_by ?? null, date_printed: meta.date_printed ?? null };
      }
    }
    for (const [id, meta] of Object.entries(rowlessSessions)) {
      if (byBatch.has(id)) continue;
      const v = sessionVerdict(meta, { pending: 0, ever: 0 });
      if (v.kind !== "failed" && v.kind !== "in_flight") continue;
      const t = meta.created_at ? Date.parse(meta.created_at) : 0;
      groups.push({ key: id, isBatch: true, batchId: id, items: [], latest: Number.isFinite(t) ? t : 0, lastTouched: 0, area: null, label: meta.label ?? null, origin: meta.origin ?? null, sourceFileId: meta.source_file_id ?? null, orderRef: meta.order_ref ?? null, trackingNumber: meta.tracking_number ?? null, shipmentState: meta.shipment_state ?? null, shipmentDescription: meta.shipment_description ?? null, shipmentLocation: meta.shipment_location ?? null, verdict: v, dateReading: null });
    }
    return groups.sort((a, b) => b.latest - a.latest);
  }, [visibleItems, batchMeta, rowlessSessions]);

  // The category label each item's SESSION agreed on, by item id.
  //
  // Reconciliation is cross-item, so a card cannot work it out alone: nine jugs
  // identified independently rendered "Figurines" and "Figurine" side by side
  // (reported 2026-08-02). Computed once here and handed to every InboxCard, so the
  // list, the sorting-plan card and the gallery modal cannot disagree - three
  // call sites, one answer.
  const sessionCategoryByItem = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const g of sessionGroups) {
      const agreed = sessionCategory(g.items).suggestion;
      for (const it of g.items) m.set(it.id, agreed);
    }
    return m;
  }, [sessionGroups]);
  // Every group (session or day) carries a meaningful time header now, so show
  // them whenever we're grouping at all.
  const showSessionHeaders = sessionGroups.length > 0;
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(new Set());
  // A sent-back item returns to its ORIGINAL spot (created_at preserved), so
  // it isn't at the top — surface it non-destructively (expand its session,
  // scroll, flash a ring). Never a created_at rewrite.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const toggleSession = (key: string) =>
    setCollapsedSessions((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Surface a sent-back item: expand its (possibly collapsed, old) session so
  // the row renders, scroll to it, then clear the ring. Re-runs as the list
  // refetches; no-ops cleanly if the item isn't grouped/visible.
  useEffect(() => {
    if (!highlightId) return;
    const grp = sessionGroups.find((g) => g.items.some((i) => i.id === highlightId));
    if (grp && collapsedSessions.has(grp.key)) {
      setCollapsedSessions((s) => {
        const n = new Set(s);
        n.delete(grp.key);
        return n;
      });
      return; // re-runs after the expand renders
    }
    const el = document.getElementById(`scan-item-${highlightId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setHighlightId(null), 2600);
    return () => clearTimeout(t);
  }, [highlightId, sessionGroups, collapsedSessions]);
  // A link to ONE row (the dashboard's captured-item card, #3049): open its
  // sheet (the item screen on a phone, the card on a desk) and mark it in the
  // list, then drop the param so a later poll does not reopen it.
  const linkedItem = params.get("item");
  useEffect(() => {
    if (!linkedItem || !items.some((i) => i.id === linkedItem)) return;
    setGalleryFocusId(linkedItem);
    setHighlightId(linkedItem);
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete("item");
        return n;
      },
      { replace: true },
    );
  }, [linkedItem, items, setParams]);
  // Camera "Done" lands on /scan#s-<batchId> — the FULL grouped inbox (all
  // sessions as sections, newest first), with the just-scanned session scrolled
  // to. This replaced landing on ?batch, which scoped the inbox to one session
  // and hid the earlier ones behind a chip (the author scanned 6 items across 3
  // sessions and couldn't find the first two). Runs once the groups render.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#s-") || !sessionGroups.length) return;
    const el = document.getElementById(hash.slice(1));
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("ring-2", "ring-cobble-400", "rounded-lg");
      const t = window.setTimeout(() => el.classList.remove("ring-2", "ring-cobble-400", "rounded-lg"), 2200);
      // Clear the hash so a later poll-rerender doesn't re-scroll.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [sessionGroups]);

  // The active scanning session (localStorage), for the "Scanning into…" chip.
  const activeSession = readScanSession(activeSlug ?? "");
  const sessionActive = isSessionFresh(activeSession);
  // Is that active session ALREADY shown as its own group in the list below?
  // When it is (the common case on /scan), the standalone green banner just
  // repeats the "Session · <time>" row — so we suppress the banner and fold
  // its one unique control (End session) onto that row instead.
  const activeSessionInList =
    !!activeSession?.batchId &&
    sessionGroups.some((g) => g.isBatch && g.batchId === activeSession.batchId);

  // Rate-limited scans are retried by the SERVER (core-scan:retry-lookup on
  // core-queue), not here. This page used to run the only retry there was: a
  // setInterval giving two attempts fifteen seconds apart, alive only while the
  // tab was open, its give-up state in component state that a reload discarded.
  // An item sat on "retrying automatically" for over an hour because of it
  // (reported 2026-08-14).
  //
  // Nothing replaces it on the client, deliberately. The worker writes the
  // outcome onto the row - it drops `rate_limited` and stamps `ai_suggested_at`
  // when the budget is spent - so `rateLimited` goes false and `needsName` goes
  // true on their own, which is exactly the state the old `rlGaveUp` set was
  // faking. The poll below picks it up.

  // Recently deleted: discarding is a soft-delete (the row + its enriched data are
  // kept), so a mistaken X is recoverable from here — no confirm needed on delete.
  const discardedQ = useQuery({
    queryKey: ["scan-inbox-discarded", activeSlug],
    queryFn: () => api.listScanInbox(activeSlug, { status: "discarded" }),
    enabled: !!activeSlug,
  });
  const recentlyDeleted = (discardedQ.data?.items ?? [])
    .slice()
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .slice(0, 20);
  const [showDeleted, setShowDeleted] = useState(false);
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreScanItem(activeSlug, id),
    onSuccess: (r) => {
      toast.success("Restored.");
      // The item returns to its ORIGINAL spot (created_at preserved — a restore
      // is an undo, same contract as sent-back). Surface it the same way:
      // expand its session, scroll to it, flash a ring.
      setHighlightId(r.id);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-inbox-discarded", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Recently committed: a confirm is revertible too — "Send back" reopens the
  // scan as pending and removes the entity it CREATED (a scan that merely
  // attached to an existing entity leaves it untouched). The mirror of
  // Recently deleted, for the other resolution — a wrong commit is redoable,
  // not a dead end.
  const resolvedQ = useQuery({
    queryKey: ["scan-inbox-resolved", activeSlug],
    queryFn: () => api.listScanInbox(activeSlug, { status: "resolved" }),
    enabled: !!activeSlug,
  });
  // The tables this workspace can file into. Needed to say WHERE something went
  // by its name rather than its internal kind, and to notice that a better home
  // has appeared since a scan was routed. Shares the ["instances", slug] cache
  // key the rest of the app uses, so it costs no extra fetch.
  const instancesQ = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const destinationTables: DestinationTable[] = (instancesQ.data?.items ?? []).map((i) => ({
    instance_name: i.instance_name,
    display_name: i.display_name,
    module_name: i.module_name,
  }));

  const recentlyCommitted = (resolvedQ.data?.items ?? [])
    .slice()
    .sort((a, b) => String(b.resolved_at ?? "").localeCompare(String(a.resolved_at ?? "")))
    .slice(0, 20);
  const [showCommitted, setShowCommitted] = useState(false);
  // Recently-committed grouped by the SESSION they were committed from, so a whole
  // receipt/scan session committed at once (e.g. "Confirm all") can be sent back in
  // ONE click — not 20 (reported 2026-07-24). Loose items (no batch) stay as singletons.
  const committedGroups = useMemo(() => {
    const byBatch = new Map<string, ScanInboxItem[]>();
    const groups: Array<{ key: string; batchId: string | null; items: ScanInboxItem[] }> = [];
    for (const it of recentlyCommitted) {
      if (it.scan_batch_id) {
        const arr = byBatch.get(it.scan_batch_id);
        if (arr) arr.push(it);
        else {
          const g = { key: it.scan_batch_id, batchId: it.scan_batch_id, items: [it] };
          byBatch.set(it.scan_batch_id, g.items);
          groups.push(g);
        }
      } else {
        groups.push({ key: it.id, batchId: null, items: [it] });
      }
    }
    return groups;
  }, [recentlyCommitted]);
  const unconfirm = useMutation({
    mutationFn: (id: string) => api.unconfirmScanItem(activeSlug, id),
    onSuccess: (r) => {
      toast.success(
        r.entity_deleted
          ? "Sent back to the inbox — the created entry was removed."
          : `Sent back to the inbox.${r.note ? ` ${r.note}` : ""}`,
      );
      setHighlightId(r.item.id);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-inbox-resolved", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-stats", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // A split parent in this list did not create an entry; it made N inbox
  // items. Sending it back would leave them (the api refuses); undoing the
  // split is the revert that fits, and it is the one offered.
  const undoSplit = useMutation({
    mutationFn: (id: string) => api.unsplitScanItem(activeSlug, id),
    onSuccess: (r) => {
      toast.success(`Split undone: the group photo is back in the inbox and its ${r.discarded} piece${r.discarded === 1 ? "" : "s"} ${r.discarded === 1 ? "is" : "are"} in Recently deleted.`);
      setHighlightId(r.parent.id);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-inbox-resolved", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-inbox-discarded", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-stats", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const splitPieces = (it: ScanInboxItem): number =>
    ((it.suggested_metadata as { split_into?: unknown } | null)?.split_into as unknown[] | undefined)?.length ?? 0;
  // Revert a set of committed items. Returns how many ACTUALLY went back —
  // allSettled hides per-item failures (a split parent 409s, an already-pending
  // item 422s), so the caller can report the truth instead of always "N sent".
  const revertIds = async (ids: string[]): Promise<{ ok: number; failed: number }> => {
    const results = await Promise.allSettled(ids.map((id) => api.unconfirmScanItem(activeSlug, id)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] }),
      qc.invalidateQueries({ queryKey: ["scan-inbox-resolved", activeSlug] }),
      qc.invalidateQueries({ queryKey: ["scan-stats", activeSlug] }),
    ]);
    return { ok, failed: ids.length - ok };
  };
  const reportRevert = ({ ok, failed }: { ok: number; failed: number }) => {
    if (ok) toast.success(`Sent ${ok} item${ok === 1 ? "" : "s"} back to the inbox.`);
    if (failed)
      toast.error(
        `${failed} item${failed === 1 ? "" : "s"} couldn't be sent back — open ${failed === 1 ? "it" : "them"} to see why.`,
      );
  };
  // Send a whole session's committed items back to the inbox at once.
  const [sendingBackAll, setSendingBackAll] = useState<string | null>(null);
  const sendBackSession = async (key: string, batchId: string | null, visibleIds: string[]) => {
    setSendingBackAll(key);
    try {
      let ids = visibleIds;
      if (batchId) {
        // The recently-committed list is a capped window; fetch the batch's FULL
        // resolved set so "Send all back" reverts the WHOLE session, not just the
        // rows that happen to be visible (reported 2026-07-25).
        try {
          const full = await api.listScanInbox(activeSlug, {
            status: "resolved",
            batch_id: batchId,
            limit: 200,
          });
          const fullIds = (full.items ?? []).map((i) => i.id);
          if (fullIds.length) ids = Array.from(new Set([...ids, ...fullIds]));
        } catch {
          /* fall back to the visible ids */
        }
      }
      reportRevert(await revertIds(ids));
    } finally {
      setSendingBackAll(null);
    }
  };
  // Revert a set of just-committed items (used by the "Undo" on a receipt/PO commit).

  // Hardware barcode scanners (USB/Bluetooth HID, 1D or 2D) "type" the code +
  // Enter. Capture that burst page-wide so a physical scan intakes a barcode
  // hands-free — no need to open the UPC modal first. Keystrokes aimed at a real
  // input (the UPC field, search…) pass through untouched (see useBarcodeWedge).
  // Optimistic feedback for a hardware scan: a phantom row with a spinner shows
  // at the top of the inbox the instant you scan, so you know it registered while
  // the lookup (a few seconds) runs — then it's swapped for the real (or
  // quantity-bumped) row once the refetch lands.
  const [pendingScans, setPendingScans] = useState<{ id: string; code: string }[]>([]);
  const wedgeScan = useMutation({
    mutationFn: async (code: string) =>
      api.scanBarcode(activeSlug, {
        barcode: code,
        source_kind: "barcode",
        // Reviewing a session (?batch) scans into IT; otherwise the time-gap
        // session, so wedge bursts group like camera bursts (camera-burst batches).
        scan_batch_id:
          batchId ??
          (await resolveSessionBatch(activeSlug, () =>
            api.createScanBatch(activeSlug).then((b) => b.id).catch(() => null),
          )) ??
          undefined,
        target_location_id: fileBin || undefined,
      }),
    onMutate: (code: string) => {
      const id = `pending-${performance.now()}`;
      setPendingScans((p) => [{ id, code }, ...p]);
      return { id };
    },
    onSuccess: (item) => {
      toast.success(`Scanned: ${displayName(item) ?? `Barcode ${item.barcode_text}`}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
    onSettled: async (_data, _err, _code, ctx) => {
      // Wait for the refetch so the real row is present before dropping the
      // phantom — no flicker-gap between the two.
      await qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      if (ctx?.id) setPendingScans((p) => p.filter((x) => x.id !== ctx.id));
    },
  });

  // ── scan-drives-screen (Phase 1): a scan is a DRIVER ─────────────────────────
  // When ON, this tab is the "driven screen" (reusing the browser-drive hub built
  // for Claude): every scan POSTs to /scan-drive, which routes a Cobblr QR →
  // navigate the driven tab there, a product barcode → intake + jump to the
  // inbox, nothing → triage. A scanner anywhere (this device's wedge, or a phone
  // BT scanner, or — Phase 2 — an edge bridge) drives whichever tab opted in.
  const scanDrive = useScanDrive(activeSlug, batchId ?? undefined);
  useBarcodeWedge({
    enabled: !!activeSlug,
    onScan: (code) => {
      if (scanDrive.on) {
        scanDrive.scan(code);
        return;
      }
      // The one classifier (lib/scanPayload.ts): what the wedge read decides
      // where it goes, the same rule as the camera and the typed field.
      const payload = classifyScanPayload(code);
      if (payload.kind !== "cobblr-qr") {
        wedgeScan.mutate(code);
        return;
      }
      // A scanned LOCATION label sets the active filing bin (and nests a container
      // under the current bin) instead of staging an item — the scan-to-set
      // flow. Any other QR stages as a normal scan.
      const token = payload.token;
      void (async () => {
        const resolved = await api.resolveQrToken(token);
        const locId = resolved?.entity_id;
        if (
          resolved?.entity_kind === "core-locations:location" &&
          locId &&
          (!resolved.org_slug || resolved.org_slug === activeSlug)
        ) {
          // Single-SKU bin → straight to the qty-adjust card (the bin's QR is
          // the item's only label). Multi-SKU / empty → filing flow below.
          try {
            const contents = await api.binContents(activeSlug, locId);
            if (contents.single && contents.items[0]) {
              const loc0 = (locsQ.data?.items ?? []).find((l) => l.id === locId);
              setWedgeBinAdjust({
                locationId: locId,
                locationName: loc0 ? filingLabel(loc0) : "this bin",
                item: contents.items[0],
              });
              return;
            }
          } catch {
            /* contents unavailable → normal filing flow */
          }
          const items = locsQ.data?.items ?? [];
          const byId = new Map(
            items.map((l) => [
              l.id,
              { id: l.id, name: l.name, short_name: l.short_name, parent_id: l.parent_id, kind: l.kind },
            ]),
          );
          const decision = decideLocationScan(locId, fileBin || null, byId);
          if (decision.reparent) {
            try {
              await api.updateLocation(activeSlug, decision.reparent.child, {
                parent_id: decision.reparent.parent,
              });
              await locsQ.refetch();
            } catch {
              /* cycle / permission — fall back to a plain adopt */
            }
          }
          setFileBin(decision.bin);
          const b = byId.get(decision.bin);
          const nm = b ? filingLabel(b) : "location";
          const p = decision.reparent ? byId.get(decision.reparent.parent) : null;
          toast.success(p ? `Filed ${nm} in ${filingLabel(p)} — filing into ${nm}` : `Filing into ${nm}`);
          return;
        }
        wedgeScan.mutate(code);
      })();
    },
  });

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
  // everywhere — so "module enabled" gates nothing. The author's rule: the field
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
  // The caller's per-workspace receipt-forwarding address (only when the
  // operator wired up the receipts@ Email Worker).
  const receiptAddrQ = useQuery({
    queryKey: ["receipt-address", activeSlug],
    queryFn: () => api.getReceiptAddress(activeSlug),
    enabled: !!activeSlug,
    staleTime: 5 * 60_000,
  });
  const receiptAddress =
    receiptAddrQ.data?.configured && receiptAddrQ.data.address ? receiptAddrQ.data.address : null;

  // Receipt lines share a receipt_group_id; offer to roll a whole receipt up
  // into one purchase order (only when the purchases module is on).

  /** An icon-sized header control. */
  const headerIcon =
    "inline-flex items-center justify-center rounded border border-line dark:border-slate-700 text-content hover:bg-subtle dark:hover:bg-slate-800/70 p-1.5 transition shrink-0";

  // ── the one intake box ────────────────────────────────────────────────────
  const [omniOpen, setOmniOpen] = useState(false);
  const omniRef = useRef<HTMLInputElement>(null);
  const submitOmni = async () => {
    const intent = classifyOmni(searchQ);
    if (intent.kind === "cobblr-qr") {
      // A pasted Cobblr label: go where the QR goes, as the camera would.
      setSearchQ("");
      navigate(`/qr/${intent.value}`);
      return;
    }
    if (intent.kind === "upc") {
      wedgeScan.mutate(intent.value);
      setSearchQ("");
      return;
    }
    if (intent.kind === "url" || intent.kind === "urls") {
      const urls = intent.value.split("\n").slice(0, 50);
      setSearchQ("");
      let ok = 0;
      let lastErr: string | null = null;
      for (const url of urls) {
        try {
          await api.scanBarcode(activeSlug, {
            source_kind: "url",
            source_url: url,
            target_location_id: fileBin || undefined,
          });
          ok++;
        } catch (e) {
          // Carry on through the rest, but KEEP the reason. Discarding it is
          // what turned a server-side 400 into a green "Added 0 URLs" that read
          // as "nothing happened" instead of "this failed, here is why"
          // (reported 2026-08-12).
          lastErr = e instanceof ApiError ? e.message : String(e);
        }
      }
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      // "Added 0" is a FAILURE whatever the loop technically did. A success
      // toast reporting zero confirms nothing and hides the one fact that would
      // explain it.
      if (ok === 0) {
        toast.error(
          (urls.length === 1 ? "Couldn't add that link" : `Couldn't add any of those ${urls.length} links`) +
            (lastErr ? `: ${lastErr}` : "."),
        );
      } else if (ok < urls.length) {
        toast.info(
          `Added ${ok} of ${urls.length} links - identifying in the inbox.` +
            (lastErr ? ` The rest failed: ${lastErr}` : ""),
        );
      } else {
        toast.success(`Added ${ok} URL${ok === 1 ? "" : "s"} - identifying in the inbox.`);
      }
    }
  };
  // Dropping a file on the box routes by TYPE, so there is no "which kind of
  // file" question: images are photo intake, a PDF/CSV is a receipt.
  //
  // Shared with PASTE below rather than written twice: a screenshot on the
  // clipboard and a file dragged onto the box are the same intake, and when
  // this routing gets smarter it has to get smarter in one place. (It needs
  // to: an IMAGE of a receipt is filed as a product today - see
  // docs/design-decisions/receipt-from-a-photo.md.)
  // The same paste arriving twice must not become two items. This handler is
  // bound to the input AND to the label around it (deliberately - the box is a
  // collapsed icon until you click it, so a paste aimed at the control has to
  // land somewhere), and preventDefault does not stop the event bubbling from
  // one to the other. That doubling is fixed at the source below, but the guard
  // lives HERE because every intake door shares this function: a double-tapped
  // upload button or a drop that fires twice would cost the same duplicate, and
  // one of those is exactly how a receipt turned into two inbox sessions
  // seconds apart (reported 2026-08-19).
  const [dropHot, setDropHot] = useState(false);
  const onOmniDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropHot(false);
    takeFiles(Array.from(e.dataTransfer.files ?? []));
  };
  // Pasting a screenshot into the box is intake too. A receipt, a listing or a
  // spec sheet usually reaches you as an image on the clipboard, and without
  // this the only route is saving it to disk to drag it back in.
  //
  // Images are intercepted ONLY when the clipboard actually carries one. A
  // normal text paste - a UPC, a link, a search - must still land in the field,
  // so preventDefault is called after that check and never before it.
  const onOmniPaste = (e: React.ClipboardEvent) => {
    const files = clipboardImages(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    // ...and stop it reaching the copy of this handler on the label outside.
    // preventDefault only cancels the browser's own behaviour; the event still
    // bubbles, so without this one paste into the focused field ran intake twice.
    e.stopPropagation();
    takeFiles(files);
  };

  // The inbox's own numbers, as ONE statement rather than four chips. They are
  // facets of the SAME pending items, so they read as a sentence and each is a
  // filter (a count in a header is a filter, never a verb).
  //
  // DISJOINT by construction: `isReadyToFile` (a name + a destination + nothing
  // flagged) reads the same review predicate as `needsReview`, so a named item
  // at 0.4 confidence counts once, under review. Showing 5 ready + 3 review
  // over 8 items when two are counted twice is a lie the eye can check, and
  // the page tells you to work this way: bulk-confirm the confident ones, then
  // focus the rest.
  const confidentCount = items.filter(isReadyToFile).length;

  // The standing bin, resolved to a location so the chip can NAME it.
  const fileBinName = fileBin ? (locsQ.data?.items ?? []).find((l) => l.id === fileBin) : null;
  // Items sitting here with no location of their own. The standing bin only
  // stamps target_location_id at SCAN time, so anything scanned before it was
  // set is still loose - this is the count the menu offers to fix.
  const looseIds = items.filter((i) => !i.target_location_id).map((i) => i.id);
  const looseCount = looseIds.length;

  // Bulk triage: select N items, then confirm / discard the whole selection at
  // once (each confirm routes to its own matchmaker top candidate, fields and
  // all). Loops the existing per-item endpoints — no server change.
  // SELECTION-NOT-CONTEXT: scan-inbox rows are not workspace records yet — they are pending things
  //   waiting to BECOME records, and their ids mean nothing to the tools
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  /** "Filing 12 of 40…" while a long batch runs - the only honest feedback a
   *  serial loop can give. Null when nothing is in flight. */
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const toggleSelected = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const clearSelected = () => setSelected(new Set());
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((i) => selected.has(i.id));
  const [bulkLocOpen, setBulkLocOpen] = useState(false);
  // Guided Organize — batch put-away plan over the selection (the sheet owns
  // plan + apply; here we just open it and clean up after applied items).
  const [organizeOpen, setOrganizeOpen] = useState(false);
  // Phase 3: the same planner over committed entities with no location yet.
  const [organizeUnplacedOpen, setOrganizeUnplacedOpen] = useState(false);
  // Live Sort — the streaming put-away session (scan → "→ Bin 1" → confirm).
  // ?livesort=1 (the onboarding mission deep link) opens it on arrival.
  const [liveSortOpen, setLiveSortOpen] = useState(() => params.get("livesort") === "1");
  // The inbox has two lenses on the SAME pending items: "By session" (grouped by
  // scan time — the default) and "Sorting plan" (grouped by destination — the
  // put-away plan, inline, not a modal). A header toggle switches between them.
  // ?view=plan (and the legacy ?organize=pending the dashboard card used to send)
  // deep-links straight to the plan lens.
  const [viewMode, setViewMode] = useState<"sessions" | "plan">(() =>
    params.get("view") === "plan" || params.get("organize") === "pending" ? "plan" : "sessions",
  );
  // Deep-link params (?view=plan / ?organize=pending, ?livesort=1) are
  // consume-once: they seed the state above, then we strip them from the URL.
  // Otherwise the param persisted, so leaving the view/modal left it in the URL
  // and every refresh re-forced it against the user's wish (reported 2026-07-10).
  // Mount-only: the useState defaults already captured the arrival value; after
  // that nothing reads these params, and the toggle/buttons are pure state.
  useEffect(() => {
    if (!params.has("organize") && !params.has("livesort") && !params.has("view")) return;
    const next = new URLSearchParams(params);
    next.delete("organize");
    next.delete("livesort");
    next.delete("view");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The put-away strip's counts (cheap SQL; also feeds the dashboard card).
  const scanStatsQ = useQuery({
    queryKey: ["scan-stats", activeSlug],
    queryFn: () => api.getScanStats(activeSlug),
    enabled: !!activeSlug,
    staleTime: 15_000,
  });
  // Warm the pending plan when unfiled items exist (debounced 5s so an active
  // scanning burst settles) — "Put them away" should reveal a ready plan, not
  // start one. Server-side fingerprint dedupe makes repeats free.
  const unfiledCount = scanStatsQ.data?.unfiled ?? 0;
  const readyCount = scanStatsQ.data?.ready ?? 0;
  useEffect(() => {
    if (!activeSlug || (unfiledCount === 0 && readyCount === 0)) return;
    const t = setTimeout(() => {
      void api.organizePlan(activeSlug, { scope: "pending", warm: true }).catch(() => {});
    }, 5_000);
    return () => clearTimeout(t);
  }, [activeSlug, unfiledCount, readyCount]);
  // Phase 2: the put-away walk. `walkPlanId` set = walk sheet open, over the
  // queue the api assembles from every plan in play. The same queue powers
  // the chip: what is accepted and still to place, whether a walk was ever
  // started, read from the items rather than from one plan's walk state, so
  // a finished walk cannot come back as "resume" and a group accepted on an
  // earlier plan is not forgotten (#2897).
  const [walkPlanId, setWalkPlanId] = useState<string | null>(null);
  const putawayQueueQ = useQuery({
    queryKey: ["organize-plan-latest", activeSlug],
    queryFn: () => api.getPutawayQueue(activeSlug),
    staleTime: 30_000,
  });
  const resumableWalk = (() => {
    const q = putawayQueueQ.data;
    if (!q || q.remaining === 0 || !q.plan_id) return null;
    return { planId: q.plan_id, remaining: q.remaining, resumed: !!q.session_id };
  })();
  // The organize plan's item accordion renders the REAL card inline, in
  // identity-fixer mode (planContext: no confirm form, no chips, no discard).
  const renderPlanItemCard = (id: string, onCollapse: () => void) => {
    const it = items.find((i) => i.id === id);
    if (!it || it.status !== "pending") return null;
    return (
      <InboxCard
        item={it}
        pageTarget={target}
        menu={menu}
        sessionCategoryLabel={sessionCategoryByItem.get(it.id) ?? null}
        hasLocations={hasLocations}
        defaultExpanded
        planContext
        onCollapse={onCollapse}
      />
    );
  };

  const startWalk = async (planId?: string) => {
    setOrganizeOpen(false);
    // Pin the plan the user just applied when we know its id; the walk's
    // queue still spans every other plan in play. Without one, the queue
    // names the newest plan with something accepted.
    const pinned = planId ?? (await api.getPutawayQueue(activeSlug).then((q) => q.plan_id).catch(() => null));
    if (pinned) setWalkPlanId(pinned);
    else toast.error("Nothing applied to walk yet - accept a group first.");
  };
  /** Set a location on a set of items. Defaults to the current selection; the
   *  header's "also set location on the N already here" passes ids directly,
   *  since those items are not (and need not be) selected. */
  const bulkApplyLocation = async (locId: string, explicitIds?: string[]) => {
    setBulkBusy(true);
    setBulkLocOpen(false);
    const ids = explicitIds ?? [...selected];
    let ok = 0;
    for (const id of ids) {
      try {
        await api.updateScanItem(activeSlug, id, { target_location_id: locId });
        ok++;
      } catch {
        /* skip failures */
      }
    }
    setBulkBusy(false);
    if (!explicitIds) clearSelected();
    void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    const name = (locsQ.data?.items ?? []).find((l) => l.id === locId);
    toast.success(`Filed ${ok} item${ok === 1 ? "" : "s"} into ${name ? filingLabel(name) : "the location"}.`);
  };
  const bulkDiscard = async () => {
    setBulkBusy(true);
    const done: string[] = [];
    for (const id of selected) {
      try {
        await api.discardScanItem(activeSlug, id);
        done.push(id);
      } catch {
        /* skip failures; summary reflects what landed */
      }
    }
    setBulkBusy(false);
    clearSelected();
    void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["scan-inbox-discarded", activeSlug] });
    // Undo inline — restores the whole batch if it was a mis-tap.
    toast.action(`Removed ${done.length} item${done.length === 1 ? "" : "s"}.`, {
      actionLabel: "Undo",
      duration: 7000,
      onAction: async () => {
        await Promise.allSettled(done.map((id) => api.restoreScanItem(activeSlug, id)));
        void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["scan-inbox-discarded", activeSlug] });
      },
    });
  };
  // Wedge-scanned a single-SKU bin's QR → the direct qty-adjust card.
  const [wedgeBinAdjust, setWedgeBinAdjust] = useState<{
    locationId: string;
    locationName: string;
    item: TrackedMatch;
  } | null>(null);
  // The item sheet: which item is open as a full triage card, on its own. The
  // gallery's tile tap opens it at every width; a list row's expand opens it
  // on a phone (#2982). `focusCand` is the chip a phone tap carried in, so the
  // sheet opens on that table's form.
  const [galleryFocusId, setGalleryFocusId] = useState<string | null>(null);
  const [focusCand, setFocusCand] = useState<ScanCandidate | null>(null);
  const openSheet = (id: string, cand: ScanCandidate | null = null) => {
    setFocusCand(cand);
    setGalleryFocusId(id);
  };
  // Fold one scan session into the previous one (merge-batches). We carry the
  // ids of the items being moved so the success toast can offer a real Undo —
  // reassigning EXACTLY those items back to their original (now-empty) batch,
  // never disturbing items that were already in the target session.
  const mergeBatches = useMutation({
    mutationFn: (v: { from: string; into: string; itemIds: string[] }) =>
      api.mergeScanBatches(activeSlug, v.from, v.into),
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.action(`Merged ${r.moved} item${r.moved === 1 ? "" : "s"} into the previous session.`, {
        actionLabel: "Undo",
        onAction: async () => {
          try {
            await api.reassignScanBatch(activeSlug, v.itemIds, v.from);
            await qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
            toast.success("Merge undone - the session is back on its own");
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        },
      });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Receipt session: view the original + re-parse it (re-run the parser on the
  // stored source, replacing the still-pending lines).
  const [viewSource, setViewSource] = useState<string | null>(null);
  /** What the receipt open in the viewer said about money, read off any of its
   *  lines (the parser stamps the receipt-level totals on every one). */
  const viewSourceMoney = useMemo(() => {
    if (!viewSource) return null;
    // The original belongs to the SESSION (batch meta carries source_file_id);
    // the lines carry the money. Reading source_file_id off a line found
    // nothing on any real receipt, so the summary shipped and never rendered
    // (found by the e2e walk against real rows, 2026-09-01).
    const g = sessionGroups.find((x) => x.sourceFileId === viewSource);
    const line = g?.items.find((i) => i.suggested_metadata && typeof i.suggested_metadata === "object");
    const m = (line?.suggested_metadata ?? null) as
      | (ReceiptMoney & { receipt_seller?: string; receipt_currency?: string })
      | null;
    if (!m) return null;
    return {
      money: {
        currency: m.currency ?? m.receipt_currency,
        list_price: m.list_price,
        discounts: m.discounts,
        net_price: m.net_price,
        tax: m.tax,
        shipping: m.shipping,
        total_charged: m.total_charged,
      } satisfies ReceiptMoney,
      soldBy: m.receipt_seller ?? null,
    };
  }, [viewSource, sessionGroups]);
  const [reparseBatch, setReparseBatch] = useState<string | null>(null);
  const reparse = useMutation({
    mutationFn: (batchId: string) => {
      setReparseBatch(batchId);
      return api.reparseReceipt(activeSlug, batchId);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success(`Read again: ${r.receipt.item_count} item${r.receipt.item_count === 1 ? "" : "s"}`);
    },
    onError: (e) => {
      // Failed again: the session's state carries the new reason; refetch so
      // the row says it rather than keeping the old sentence.
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.error(e instanceof ApiError ? e.message : String(e));
    },
    onSettled: () => setReparseBatch(null),
  });
  // Edit the order/invoice # on a receipt session (add one the parser missed, or
  // fix a wrong one). The label recomputes server-side.
  const [editingPo, setEditingPo] = useState<string | null>(null);
  const [poInput, setPoInput] = useState("");
  // Getting OUT of the field. It had only an inline onKeyDown for Escape, which
  // works right up until the input loses focus - and this list refetches on a
  // timer, so a re-render mid-edit leaves the field on screen with the caret
  // gone, at which point Escape reaches nobody and clicking away does nothing
  // either (reported 2026-08-12: "click elsewhere or ESC does not get out").
  //
  // Both exits are handled at the DOCUMENT here, so neither depends on where
  // focus happens to be. Same shape HeaderMenu uses for its outside-click.
  const poEditRef = useRef<HTMLSpanElement>(null);
  // The tracking number is edited the same way, in the same row, so it shares
  // these exits rather than growing a second copy of them that can drift.
  const [editingTracking, setEditingTracking] = useState<string | null>(null);
  const [trackingInput, setTrackingInput] = useState("");
  const trackingEditRef = useRef<HTMLSpanElement>(null);
  // Which receipt is showing its parcel's status. Shares the exits below, so
  // Escape and a click outside close it like every other transient panel here.
  const [trackingPopover, setTrackingPopover] = useState<string | null>(null);
  /** Where to draw the parcel panel, since it is portaled out of the row
   *  that would otherwise clip it. */
  const [trackingRect, setTrackingRect] = useState<{ top: number; left: number } | null>(null);
  const trackingPopRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!editingPo && !editingTracking && !trackingPopover) return;
    const closeAll = () => {
      // Escape must not dump keyboard users at the document root - hand focus
      // back to the trigger, the way the destination menu does.
      if (trackingPopover) trackingPopRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      setEditingPo(null);
      setEditingTracking(null);
      setTrackingPopover(null);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // A PORTALED panel is outside every ref here, because a portal escapes the
      // React tree in the DOM as well. Without this, opening the parcel panel and
      // clicking anything in it closes the panel on mousedown, before the click
      // lands - and marking it in the DOM covers whatever gets portaled next,
      // where remembering to add another ref would not.
      if ((t as HTMLElement).closest?.("[data-portal-panel]")) return;
      if (
        poEditRef.current?.contains(t) ||
        trackingEditRef.current?.contains(t) ||
        trackingPopRef.current?.contains(t)
      ) {
        return;
      }
      closeAll();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [editingPo, editingTracking, trackingPopover]);
  // Same reason the destination menu closes on scroll: the panel's position is
  // measured once at open, so a page that scrolls underneath leaves it floating
  // away from its button. Close rather than chase it.
  useEffect(() => {
    if (!trackingPopover) return;
    const onScroll = () => setTrackingPopover(null);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [trackingPopover]);
  const setOrderRef = useMutation({
    mutationFn: (v: { batchId: string; orderRef: string | null }) =>
      api.setReceiptOrderRef(activeSlug, v.batchId, v.orderRef),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      setEditingPo(null);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const setTracking = useMutation({
    mutationFn: (v: { batchId: string; tracking: string | null }) =>
      api.setReceiptTracking(activeSlug, v.batchId, v.tracking),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      setEditingTracking(null);
      // Say what it CHANGED, not just that it saved: filing this receipt now
      // records the order as still on its way instead of already here, and that
      // is the part a person would not guess from a number appearing in a row.
      if (v.tracking) toast.success("Tracking number saved. This receipt will file as still in transit.");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // "Add all to …" — commit the whole selection into ONE explicit table
  // (overriding each item's own routing). The bulk form of picking a target.
  const [bulkTargetOpen, setBulkTargetOpen] = useState(false);
  const bulkAddAllTo = async (entry: ScanMenuEntry) => {
    setBulkBusy(true);
    setBulkTargetOpen(false);
    const byId = new Map(items.map((i) => [i.id, i]));
    let ok = 0;
    let skipped = 0;
    for (const id of selected) {
      const it = byId.get(id);
      if (!it || !displayName(it)) {
        skipped++;
        continue;
      }
      try {
        await api.confirmScanItem(activeSlug, id, {
          target_module: entry.module,
          target_kind: entry.kind.includes(":") ? entry.kind.split(":")[1] : entry.kind,
          instance: entry.instance ?? undefined,
          name: displayName(it) ?? undefined,
          quantity: it.quantity ?? undefined,
          location_id: it.target_location_id ?? undefined,
        });
        ok++;
      } catch {
        skipped++;
      }
    }
    setBulkBusy(false);
    clearSelected();
    void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    toast.success(`Added ${ok} to ${entry.label}${skipped ? ` — ${skipped} skipped (no name / failed)` : ""}`);
  };
  // Commit each item to its OWN top candidate — the destination the matchmaker
  // already picked ("as-is" routing). Shared by the selection bulk-confirm and
  // the per-session "File all" button. A pending item without a confident
  // candidate or a name stays pending for a manual look and is reported;
  // already-resolved items in the set are skipped silently.
  // The batch question, with a choice PER TABLE. The shared confirm was
  // all-or-nothing: "file where they belong" moved every group or none, so
  // agreeing about the teas meant also agreeing about the spices. Same promise
  // bridge the ConfirmProvider uses - the async chokepoint awaits, the modal
  // resolves - with the answer being which tables you accepted.
  const [batchAsk, setBatchAsk] = useState<{
    groups: Array<{ instance: string; label: string; count: number; sample: string }>;
    resolve: (accepted: Set<string> | null) => void;
  } | null>(null);
  const [batchAccepted, setBatchAccepted] = useState<Set<string>>(new Set());

  const confirmItemsToTheirCandidate = async (
    ids: Iterable<string>,
    agreedCategory?: string | null,
    agreedLocationId?: string | null,
  ) => {
    const byId = new Map(items.map((i) => [i.id, i]));

    // ASK BEFORE FILING A BATCH INTO THE WRONG TABLE.
    //
    // Each card carries a "Tea?" chip when a better table exists, which works
    // when you are reading cards. It does nothing for "file all": you never see
    // the lines, so ten teas went into Inventory with ten unread suggestions
    // attached. Expecting a tap per line is not a fix, it is the same work moved.
    //
    // So the batch is checked ONCE, here, at the chokepoint every bulk path
    // goes through - not at the two call sites, which would be two copies to
    // drift. One question, grouped by table, and "file as-is" stays one click
    // away because the suggestion is a suggestion.
    const tables = (menu ?? []).map((m) => ({
      instance_name: m.instance ?? m.module,
      display_name: m.label,
      module_name: m.module,
      keywords: m.scan_keywords ?? [],
    }));
    const idList = [...ids];
    // Grouped by TABLE and carrying ids, not names. Names are for reading; two
    // jars of the same thing share one, and an unnamed scan has none at all, so
    // matching rows back by name would move the wrong ones.
    const misrouted = new Map<string, { label: string; entry: ScanMenuEntry; ids: string[]; names: string[] }>();
    for (const id of idList) {
      const it = byId.get(id);
      if (!it) continue;
      const cand = it.suggested_candidates?.[0] as { kind?: string; module?: string } | undefined;
      const better = betterDestination(displayName(it) ?? "", cand?.kind ?? null, tables, cand?.module ?? null);
      if (!better) continue;
      const entry = (menu ?? []).find((m) => (m.instance ?? m.module) === better.instance_name);
      if (!entry) continue;
      const label = better.display_name ?? better.instance_name;
      const cur = misrouted.get(label) ?? { label, entry, ids: [], names: [] };
      cur.ids.push(id);
      cur.names.push(displayName(it) ?? "one scan");
      misrouted.set(label, cur);
    }
    if (misrouted.size > 0) {
      const groups = [...misrouted.values()];
      // Every table starts ACCEPTED: the common case is "yes, obviously" (five
      // teas to Tea), and the checkbox exists for the one group you disagree
      // with - unticking it files that group as-is without costing the others.
      setBatchAccepted(new Set(groups.map((g) => g.entry.instance ?? g.entry.module)));
      const accepted = await new Promise<Set<string> | null>((resolve) => {
        setBatchAsk({
          groups: groups.map((g) => ({
            instance: g.entry.instance ?? g.entry.module,
            label: g.label,
            count: g.ids.length,
            sample: `${g.names.slice(0, 3).join(", ")}${g.names.length > 3 ? `, +${g.names.length - 3}` : ""}`,
          })),
          resolve,
        });
      });
      setBatchAsk(null);
      // Closing the dialog aborts the whole filing - nothing moves, nothing
      // files. Escape must never mean "do the irreversible thing anyway".
      if (accepted === null) return;
      {
        // Each ACCEPTED group goes to its own table in the one pass: five teas
        // to Tea and five spices to Spices; an unticked group files as-is.
        for (const g of groups.filter((g) => accepted.has(g.entry.instance ?? g.entry.module))) {
          for (const id of g.ids) {
            const it = byId.get(id);
            if (!it) continue;
            byId.set(id, {
              ...it,
              suggested_candidates: [
                {
                  ...(it.suggested_candidates?.[0] ?? ({} as ScanCandidate)),
                  module: g.entry.module,
                  instance: g.entry.instance,
                  kind: g.entry.kind,
                  label: g.entry.label,
                },
                ...(it.suggested_candidates ?? []).slice(1),
              ],
            } as typeof it);
          }
        }
      }
    }

    // INSTALL what these items are routed to, before confirming any of them.
    //
    // A top candidate can be a bundle the workspace does not have — the card
    // shows those as "Install & add", and the pill installs before it commits.
    // This sweep did not: it posted a confirm naming an instance that does not
    // exist, and the API answered, correctly, 404 "No instance 'groceries' in
    // this workspace." A whole receipt of groceries failed on every line
    // (reported 2026-08-21).
    //
    // Once per BUNDLE, not once per item: four lines routed to Groceries need
    // one install between them.
    //
    // KEEP THE ANSWER. Installing is only half of it - the install also reports
    // which target it really created, and for a bundle that skins a module's
    // default table (Groceries) that target has NO instance, while the
    // candidate still carries the synthetic token the routing menu needed to
    // name the bundle. Confirming the candidate verbatim therefore asked for an
    // instance that installing had just declined to create, and every line of
    // the receipt 404'd on a bundle that had installed perfectly (2026-08-22).
    const needed = new Map<string, string>();
    for (const id of ids) {
      const cand = byId.get(id)?.suggested_candidates?.[0] as
        | { bundle_external_id?: string; label?: string }
        | undefined;
      if (cand?.bundle_external_id) needed.set(cand.bundle_external_id, cand.label ?? "a table");
    }
    const installed = new Map<string, { instance: string | null }>();
    for (const bundleId of needed.keys()) {
      const fallback = [...ids]
        .map((id) => byId.get(id)?.suggested_candidates?.[0])
        .find((c) => (c as { bundle_external_id?: string } | undefined)?.bundle_external_id === bundleId)
        ?.instance;
      const instance = await resolveInstanceForFiling(activeSlug, bundleId, fallback, (sum) => {
        const line = installToastLine(sum);
        if (line) toast.success(line);
      });
      installed.set(bundleId, { instance: instance ?? null });
    }
    let ok = 0;
    let merged = 0;
    let skipped = 0;
    let failed = 0;
    let lastErr: string | null = null;
    let n = 0;
    for (const id of idList) {
      n++;
      // A 40-line receipt is 40 serial round-trips; with no visible progress
      // users reloaded the tab mid-batch. The label is the progress bar.
      if (idList.length > 5) setBulkProgress(`Filing ${n} of ${idList.length}…`);
      const it = byId.get(id);
      // ALREADY HAVE ONE? Then this is "+N, more of the same", not a new
      // record. The closed card already refuses one-tap Add for exactly this
      // reason; the bulk sweep used to create the duplicate anyway, and two
      // rows of one product differing only in word order ("Roma Tomatoes" /
      // "Tomatoes Roma") is not something anybody should have to spot.
      const attach = it ? attachBodyFor(it) : null;
      let mergedThis = false;
      if (attach) {
        try {
          await api.scanAttach(activeSlug, id, attach);
          merged++;
          mergedThis = true;
        } catch (e) {
          // The match is stamped at scan time and the entity can be gone by
          // now. A stale match must not cost the item its filing: fall through
          // and create it, which is what would have happened anyway.
          console.warn("[scan] merge into existing failed, filing as new:", e);
        }
      }
      if (mergedThis) continue;
      const bundleId = (it?.suggested_candidates?.[0] as { bundle_external_id?: string } | undefined)
        ?.bundle_external_id;
      const body = it
        ? confirmBodyFor(
            it,
            agreedCategory,
            agreedLocationId,
            (bundleId && installed.get(bundleId)) || null,
            // The DECLARED category axis, so the agreed category applies even
            // when the stored value spells it differently than the candidate.
            categoryAxisKey(it, menu),
          )
        : null;
      if (!body) {
        if (it && it.status === "pending") skipped++;
        continue;
      }
      try {
        await api.confirmScanItem(activeSlug, id, body);
        ok++;
      } catch (e) {
        failed++;
        // The endpoint's message is actionable ("Enable Inventory in
        // Configuration") - throwing it away turned every total failure into
        // an unexplained green "0 confirmed · N failed" (2026-08-25 audit).
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    setBulkProgress(null);
    void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    const parts = [`${ok} confirmed`];
    if (merged) parts.push(`${merged} added to what you already had`);
    if (skipped) parts.push(`${skipped} need a manual look`);
    if (failed) parts.push(`${failed} failed${lastErr ? ` - ${lastErr}` : ""}`);
    if (ok === 0 && failed > 0) toast.error(parts.join(" · "));
    else if (failed > 0) toast.info(parts.join(" · "));
    else toast.success(parts.join(" · "));
    return { ok, merged, skipped, failed };
  };
  const bulkConfirm = async () => {
    setBulkBusy(true);
    // The standing bin covers selected items that carry no location of their
    // own (scanned before it was set) — same rule as the header's File all.
    // An item's own location still wins inside confirmBodyFor.
    await confirmItemsToTheirCandidate(selected, null, fileBin || null);
    setBulkBusy(false);
    clearSelected();
  };
  // "File all" on a session header: confirm every ready item in that session to
  // its own candidate. The button only shows once the AI is done (busy===0), so
  // routing is settled.
  const fileSession = async (ids: string[], agreedCategory?: string | null, agreedLocationId?: string | null) => {
    setBulkBusy(true);
    await confirmItemsToTheirCandidate(ids, agreedCategory, agreedLocationId);
    setBulkBusy(false);
  };
  // Which session is mid-"where does this go?" - filing needs a place as well as
  // a category, so the button asks instead of quietly filing homeless items.
  const [placingSession, setPlacingSession] = useState<string | null>(null);
  /** Whether the open location strip will just SET the session's place (opened
   *  from the header chip) or set it AND file (opened from the File button). */
  const [placingMode, setPlacingMode] = useState<"set" | "file">("file");

  /** Give every item in a session one location, without filing anything. The
   *  header's location chip uses this: a person who wants to say "these all live
   *  in the closet" should not have to commit them in the same breath. */
  const applySessionLocation = async (ids: string[], locId: string, onlyUnset = false) => {
    setBulkBusy(true);
    let ok = 0;
    let lastErr: string | null = null;
    // A location a user picked for ONE item (the camera's "where does this one
    // go?", the card picker) is a decision, not a blank - the session chip must
    // fill gaps, never overwrite it. The chip itself knows the set is mixed;
    // the write has to know it too.
    const byId = new Map(items.map((i) => [i.id, i]));
    const targets = onlyUnset
      ? ids.filter((id) => !byId.get(id)?.target_location_id)
      : ids;
    for (const id of targets) {
      try {
        await api.updateScanItem(activeSlug, id, { target_location_id: locId });
        ok++;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    setBulkBusy(false);
    void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    const loc = (locsQ.data?.items ?? []).find((l) => l.id === locId);
    const where = loc ? filingLabel(loc) : "the location";
    if (ok === 0 && targets.length > 0) {
      // "0 items set to Kitchen Shelf" in a green toast is a failure wearing a
      // success costume (2026-08-25 audit).
      toast.error(`Couldn't set the location${lastErr ? ` - ${lastErr}` : ""}`);
    } else {
      const kept = onlyUnset && targets.length < ids.length ? ids.length - targets.length : 0;
      toast.success(
        `${ok} item${ok === 1 ? "" : "s"} set to ${where}${kept ? ` (${kept} kept the place you already gave them)` : ""}. File when you are ready.`,
      );
    }
  };

  return (
    <div className="space-y-3 max-w-4xl mx-auto">
      {/* ── ONE header row ───────────────────────────────────────────────────
          It never WRAPS; it yields, in a declared order (the field collapses to
          a magnifier, labels drop to icons, the title goes, informational
          labels truncate to a legible floor). Picking max-widths that happen to
          fit today's copy is what produced the old two-row header, where
          "Email receipts" and the overflow orphaned onto a second line.
          See docs/design-decisions/interface-principles.md #5 and #6. */}
      {/* On a phone the omni box is collapsed, so nothing in the row is elastic
          and every control packs left with dead space trailing after the ...
          menu. `justify-between` hands the leftover width to the GAPS - evenly,
          between every element - rather than pooling it in one place, so the
          row breathes and the trailing actions still finish at the right edge.
          A first attempt used a single flex-1 spacer: that right-aligned the
          icons but left one canyon after "Set location", which is not the same
          thing (reported 2026-08-10). gap-* stays the FLOOR; from `sm` up the
          omni box is the elastic member and normal packing is correct. */}
      <div className="relative flex items-center gap-2 max-sm:gap-1.5 max-sm:justify-between flex-nowrap border-b border-line dark:border-slate-700 pb-2.5">
        {/* The nav bar above already names this page, so on a phone the word
            "Inbox" is row width spent repeating the shell (principle #4). */}

        {/* The backlog as ONE sentence. Facets of the same items, each a
            filter, never a verb (principle #3 - there is no bulk confirm). */}
        {/* The counts YIELD too. They were `shrink-0`, so with a real backlog
            (81 pending · 46 ready · 4 review · 49 waiting) four two-digit facets
            came to 145px and pushed the row 14-32px past every phone width -
            the location chip was the only shrinkable member and its 96px floor
            could not absorb it (reported 2026-08-05, reporting it a second time).
            `min-w-0` + overflow-x makes an overflow structurally impossible at
            ANY count; dropping the separators on a phone (the glyphs already
            say which facet is which) means it never actually has to scroll. */}
        {/* Title + counts stay ONE group so they shrink together, but the group
            centres like every other member of the row. It was items-baseline:
            that aligned "Inbox" to the counts, and in doing so pushed the whole
            group's text ~2px BELOW the chips beside it, because a baseline box
            reserves descender room the chips' centred text does not. The ask was
            always "align Inbox with the rest of the top row", and the row's
            currency is centres (reported 2026-08-08, again 2026-08-10). */}
        <div className="flex items-center gap-2 shrink min-w-0">
        <h1 className="hidden sm:block text-lg font-semibold text-content dark:text-mortar-100 shrink-0">
          Inbox
        </h1>
        <div className="flex items-baseline gap-0 shrink min-w-0 leading-none overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden whitespace-nowrap text-[13px] text-muted dark:text-slate-400">
          <span className="text-sm font-semibold text-content dark:text-mortar-100">
            {totalPending}
          </span>
          {/* `xs:` is not a breakpoint in this project (no custom screens), so
              the old "hidden xs:inline sm:inline" was just "hidden sm:inline"
              wearing a dead class. The word costs ~50px that a phone row spends
              better on the location; an EMPTY inbox keeps it, because a lone
              "0" is a riddle. */}
          {/* The word is a DESKTOP luxury: on a tablet it cost ~55px and the
              counts were compressed to pay for it. The number leading a row of
              facets is unambiguous without it. An EMPTY inbox keeps it, since a
              lone "0" is a riddle. */}
          <span className={totalPending === 0 ? "" : "hidden lg:inline"}>&nbsp;pending</span>
          {confidentCount > 0 && confidentCount < totalPending && (
            <>
              <span className="hidden sm:inline px-1 text-faint">·</span>
              <button
                type="button"
                onClick={() => {
                  setReviewOnly(false);
                  setStaleOnly(false);
                }}
                title="A confident name and destination, nothing flagged - these are what File all commits"
className="ml-1.5 sm:ml-0 rounded px-1 py-0.5 text-[12.5px] hover:bg-subtle dark:hover:bg-slate-800 transition"
              >
                <b className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {confidentCount}
                </b>
                <span className="hidden lg:inline">&nbsp;ready</span>
                <span className="lg:hidden">&nbsp;✓</span>
              </button>
            </>
          )}
          {reviewCount > 0 && (
            <>
              <span className="hidden sm:inline px-1 text-faint">·</span>
              <button
                type="button"
                onClick={() => {
                  setStaleOnly(false);
                  setReviewOnly((v) => !v);
                }}
                aria-pressed={reviewOnly}
                title="No clean name, low confidence, or the lookup was rate-limited - these need a human"
                className={
                  "ml-1.5 sm:ml-0 rounded px-1 py-0.5 text-[12.5px] transition " +
                  (reviewOnly
                    ? "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200"
                    : "hover:bg-subtle dark:hover:bg-slate-800")
                }
              >
                <b className="font-semibold text-amber-600 dark:text-amber-400">{reviewCount}</b>
                <span className="hidden lg:inline">&nbsp;to review</span>
                <span className="lg:hidden">&nbsp;⚠</span>
              </button>
            </>
          )}
          {/* A facet covering the WHOLE set states one fact twice ("69 pending ·
              69 waiting 2d+"), so it earns its space only as a subset. */}
          {/* Desktop only. Of the four, this is the one that is NOT a disjoint
              slice - a waiting item is also ready or needing review - so it is
              the first to give up its spot when the row is tight. It stays
              reachable in the ... menu on a phone. */}
          {staleCount > 0 && staleCount < totalPending && (
            <span className="hidden sm:contents">
            <>
              <span className="hidden sm:inline px-1 text-faint">·</span>
              <button
                type="button"
                onClick={() => {
                  setReviewOnly(false);
                  setStaleOnly((v) => !v);
                }}
                aria-pressed={staleOnly}
                title="Waiting more than two days"
                className={
                  "ml-1.5 sm:ml-0 rounded px-1 py-0.5 text-[12.5px] transition " +
                  (staleOnly
                    ? "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200"
                    : "hover:bg-subtle dark:hover:bg-slate-800")
                }
              >
                {/* Glyph at EVERY width: "waiting 2d+" is the longest label on
                    the row and belongs to the facet that earns it least. The
                    words live in the tooltip. */}
                <b className="font-semibold">{staleCount}</b>&nbsp;⏱
              </button>
            </>
            </span>
          )}
        </div>
        </div>

        {/* Reviewing one session (?batch). Was a chip at the end of a wrapping
            row, where it was the first thing to fall off. */}
        {batchId && (
          <Link
            to="/scan"
            title="Filtered to this scan session - tap to show everything pending"
            className="inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 px-2.5 py-0.5 text-xs text-content dark:text-mortar-100 shrink min-w-0 max-w-[9rem] sm:max-w-none hover:border-cobble-400"
          >
            <span className="truncate">
              {(() => {
                const newest = items[0];
                const t = newest ? Date.parse(newest.created_at) : NaN;
                const area = items.find((i) => i.scan_area)?.scan_area;
                return `session${Number.isFinite(t) ? ` · ${formatSessionTime(t)}` : ""}${area ? ` · ${area}` : ""}`;
              })()}
            </span>
            <X size={12} className="text-faint shrink-0" />
          </Link>
        )}

        {/* Where the NEXT scan files. The label is the ACTION at every width -
            "Set location" reads the same on a phone and a desktop, so there is
            one term to learn rather than a per-breakpoint synonym
            (reported 2026-08-01). The MENU carries the scope the label cannot. */}
        {locsEnabled && (
          <HeaderMenu
            width={300}
            // The declared order of sacrifice: this label truncates before the
            // row is allowed to overflow, and never below a legible floor.
            shrinkable
            minWidth={104}
            // A FLOOR without a CEILING is half a yield rule: the chip could
            // shrink, but a long location name ("Guest Bedroom Closet Shelf 3")
            // grew it to 177px and squeezed the counts instead. It truncates
            // rather than expands; the full name is in its tooltip and its menu.
            className="max-w-[7rem] sm:max-w-[10rem]"
            trigger={({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                title={
                  fileBinName
                    ? `New scans file into ${filingLabel(fileBinName)}. Items already in the inbox keep their own location.`
                    : "Choose where new scans file as you scan them"
                }
                className={
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] font-medium min-w-0 transition " +
                  (fileBin
                    ? "border-cobble-400 dark:border-cobble-600 bg-cobble-50/60 dark:bg-cobble-900/25 text-content dark:text-mortar-100"
                    : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:border-cobble-400")
                }
              >
                <MapPin size={12} className="shrink-0" />
                <span className="truncate">
                  {fileBinName ? filingLabel(fileBinName) : "Set location"}
                </span>
              </button>
            )}
          >
            {({ close }) => (
              <>
                <MenuHead>New scans go to</MenuHead>
                <MenuNote>
                  Applies to what you scan next. Items already here keep their own
                  location until you file them.
                </MenuNote>
                {/* The CHIP picker, not the tree picker: a tree picker is itself
                    a collapsed dropdown, so nesting one here made setting a
                    location a two-click errand inside a menu that exists to
                    make it one. */}
                <div className="max-h-64 overflow-y-auto px-2 pb-1.5">
                  <LocationChipPicker
                    value={fileBin || null}
                    onChange={(v) => {
                      setFileBin(v ?? "");
                      close();
                    }}
                  />
                </div>
                {fileBin && (
                  <>
                    <MenuSep />
                    {/* The bridge between the two location controls: the standing
                        bin only stamps FUTURE scans, so this is how the items
                        already sitting here get the same home. Without it, a bin
                        set after scanning silently left them unplaced. */}
                    {looseCount > 0 && (
                      <MenuItem
                        icon={<MapPin size={14} />}
                        label={
                          <>
                            Also set location on the <b>{looseCount}</b> already here
                          </>
                        }
                        hint="The ones with no location of their own"
                        onClick={() => {
                          close();
                          void bulkApplyLocation(fileBin, looseIds);
                        }}
                      />
                    )}
                    <MenuItem
                      icon={<X size={14} />}
                      label="Stop filing new scans"
                      onClick={() => {
                        setFileBin("");
                        close();
                      }}
                    />
                  </>
                )}
              </>
            )}
          </HeaderMenu>
        )}

        {/* ONE intake box. Words filter; a pasted code or link offers to add;
            a dropped file routes by type. Two text boxes side by side was the
            reason this header needed two rows. */}
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDropHot(true);
          }}
          onDragLeave={() => setDropHot(false)}
          onDrop={onOmniDrop}
          // Also on the LABEL, not only the input: the box is collapsed to an
          // icon until you click it, so a paste aimed at the control lands here
          // when the field is not focused yet.
          onPaste={onOmniPaste}
          onClick={() => {
            if (!omniOpen) {
              setOmniOpen(true);
              setTimeout(() => omniRef.current?.focus(), 0);
            }
          }}
          className={
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition min-w-0 " +
            (dropHot
              ? "border-accent border-dashed bg-cobble-50/60 dark:bg-cobble-900/25 "
              : "border-dashed border-line dark:border-slate-700 ") +
            // Wide: always open and elastic, sharing the row. Tight: it MORPHS
            // over the whole row - absolutely positioned across it, so the
            // counts, the location chip and the icons are covered rather than
            // competing for the same line. Sharing the row on a phone left the
            // field a stub and the placeholder cut mid-word, which reads as
            // broken (reported 2026-08-10). Same control, two shapes.
            (omniOpen
              ? "flex-1 min-w-[9rem] max-sm:absolute max-sm:inset-x-0 max-sm:top-0 max-sm:bottom-2.5 max-sm:z-20 max-sm:flex-none max-sm:bg-canvas max-sm:dark:bg-slate-800"
              : "flex-1 min-w-[9rem] hidden sm:flex") +
            " " +
            (omniOpen ? "" : "cursor-text")
          }
        >
          {omniIntent.kind === "upc" ? (
            <ScanLine size={13} className="shrink-0 text-accent" />
          ) : omniIntent.kind === "url" || omniIntent.kind === "urls" ? (
            <ExternalLink size={13} className="shrink-0 text-accent" />
          ) : (
            <Search size={13} className="shrink-0 text-faint" />
          )}
          <input
            ref={omniRef}
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onPaste={onOmniPaste}
            onBlur={() => {
              // Collapsing while it holds text would eat the search you are
              // in the middle of typing.
              if (!searchQ.trim()) setOmniOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && omniIntent.action) {
                e.preventDefault();
                void submitOmni();
              } else if (e.key === "Escape") {
                setSearchQ("");
                e.currentTarget.blur();
              }
            }}
            placeholder={omniPlaceholder(false)}
            aria-label="Search the inbox, or paste a UPC or link to add"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-content dark:text-mortar-100 placeholder:text-faint outline-none"
          />
          {/* Upload progress reports where the upload was STARTED, so a
              multi-photo add still says "3/8" instead of going quiet once its
              button became a menu row. */}
          {uploading && (
            <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-muted dark:text-slate-400">
              <Loader2 size={11} className="animate-spin" />
              {uploadProgress ? `${uploadProgress.done}/${uploadProgress.total}` : "adding…"}
            </span>
          )}
          {omniIntent.action ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                void submitOmni();
              }}
              className="shrink-0 rounded-full bg-cobble-600 hover:bg-cobble-700 px-2 py-0.5 text-[11px] font-medium text-white transition"
            >
              {omniIntent.action}
            </button>
          ) : searchQ ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                setSearchQ("");
              }}
              aria-label="Clear search"
              className="shrink-0 text-faint hover:text-content"
            >
              <X size={12} />
            </button>
          ) : (
            // Covering the row means the way out has to be visible: an empty
            // field closes on blur, but nothing on screen said so.
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                setSearchQ("");
                setOmniOpen(false);
              }}
              aria-label="Close search"
              className="shrink-0 text-faint hover:text-content sm:hidden"
            >
              <X size={12} />
            </button>
          )}
        </label>

        {/* Adding a photo from this device is a PRIMARY way things get into the
            inbox, so it is a control on the row - not a menu row, and not an
            icon hidden inside the search box, which is where it was and is why
            it went missing on a phone entirely (reported 2026-08-10).
            Single-purpose: one tap, straight to the picker, no intermediate
            menu, which is what earns it a picture icon rather than the generic
            paperclip. On DESKTOP the camera sits beside it and the two glyphs
            say which is which: camera = the live scanner, picture = photos you
            already have. On a phone this row has no camera at all - it is
            `hidden sm:inline-flex`, because the app nav above already carries
            one - so the distinction is between bars, not within this one.
            Receipt + import stay in the ... menu: rarer, and each needs a
            sentence to explain. */}
        {/* Tight widths: the magnifier that morphs into the box above. It sits
            LEFT of upload because reading order is search-then-act, and the
            two were the other way round (reported 2026-08-10). */}
        {!omniOpen && (
          <button
            type="button"
            onClick={() => {
              setOmniOpen(true);
              setTimeout(() => omniRef.current?.focus(), 0);
            }}
            aria-label="Search the inbox"
            className={headerIcon + " sm:hidden"}
          >
            <Search size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title="Upload a photo or a receipt from this device"
          aria-label="Upload a photo or a receipt from this device"
          className={headerIcon + " disabled:opacity-50"}
        >
          {uploading ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
        </button>


        {/* ONE upload door for everything that is "a pic or a receipt": the
            file's TYPE routes it where it can. A PDF or CSV is only ever a
            receipt, so it goes to the parser. An IMAGE goes into the intake
            as a photo, and the identify step's verdict sends a receipt on to
            the receipt parser server-side (receipt-photo.ts): nothing on THIS
            side can tell the two apart (receipt-from-a-photo.md, measured),
            but the platform can, and asking the person on every upload broke
            the promise the inbox is built on, "upload anything and it figures
            it out" (#2882). The ask (UploadKindSheet) survives only for a
            workspace with no AI that can look at an image. Anything that is
            neither - an export to import - stays an explicit menu item,
            grouped with Export, because it is not a pic or a receipt and
            pretending otherwise would make this control mean nothing. */}
        {/* The same intake as a drop or a paste (takeFiles): this input kept
            its own routing once and sent every image to the photo pipeline
            while the drop path had learned better (#2845). One picker, shared
            with the dashboard's Photos tile (#3042). */}
        <ScanPickerInput ref={fileRef} onFiles={takeFiles} />
        <input
          ref={receiptRef}
          type="file"
          accept="application/pdf,image/*,.csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadReceipt(f);
          }}
        />


        {/* A feature nobody can find is a feature that does not exist, so the
            receipt address keeps a visible affordance on desktop and reveals +
            copies in one press (principle #2). On a phone it moves into the
            overflow rather than vanishing. The chip itself is shared with the
            Purchases header - see ReceiptAddressChip. */}
        {receiptAddress && (
          <ReceiptAddressChip address={receiptAddress} className="hidden sm:inline-flex" />
        )}

        {/* Everything that is real but rare: ScanInboxMenu.tsx. */}
        <ScanInboxMenu
          handheld={handheld}
          triggerClassName={headerIcon}
          gallery={{ on: galleryView, toggle: toggleGalleryView }}
          stale={{
            count: staleCount,
            total: totalPending,
            on: staleOnly,
            toggle: () => {
              setReviewOnly(false);
              setStaleOnly((v) => !v);
            },
          }}
          onLiveSort={() => setLiveSortOpen(true)}
          onFillPhotos={() =>
            void api
              .backfillScanCatalogPhotos(activeSlug)
              .then((r) =>
                toast.success(
                  r.queued
                    ? `Finding photos for ${r.queued} item${r.queued === 1 ? "" : "s"}…`
                    : "Every named item already has a photo",
                ),
              )
              .catch((e) => toast.error(e instanceof ApiError ? e.message : String(e)))
          }
          onUploadReceipt={() => receiptRef.current?.click()}
          onExport={() => setExportOpen(true)}
          onImport={() => setImportOpen(true)}
          receiptAddress={receiptAddress}
          onOrganizeUnplaced={() => setOrganizeUnplacedOpen(true)}
          scanDrive={scanDrive}
          photoRank={{ can: canSetPhotoRank, data: photoRank.data, pending: setPhotoRank.isPending, set: (v) => setPhotoRank.mutate(v) }}
          glance={{ data: glanceCfg.data, pending: setGlanceCfg.isPending, set: (v) => setGlanceCfg.mutate(v) }}
          onFileEverything={() => setFileEverything({ batchId: null, defaultLocationId: fileBin || null, scope: "the inbox" })}
          onDuplicates={() => setShowDuplicates(true)}
        />
      </div>

      <AiOffNotice status={aiStatus} needs="identify" />

      <ScanDrivePanel drive={scanDrive} />

      {/* When you arrived here from an instance's table ("Scan" on the Yarn
          page), confirms default into that instance. */}
      {target && (
        <div className="rounded-md border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2 text-sm text-content dark:text-mortar-100 flex items-center gap-2">
          <ScanLine size={15} className="text-accent shrink-0" />
          Scanning into <strong>{target.label}</strong>  - each confirm adds it to that table.
        </div>
      )}

      {list.isLoading && <div className="text-sm text-faint">loading…</div>}
      {/* An error is NOT an empty inbox. Rendering the friendly empty state on
          a failed fetch told a user with 80 pending scans that they had none,
          and they re-scanned things they already had (2026-08-25 audit). */}
      {list.isError && !list.isLoading && (
        <div className="rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-6 text-center">
          <div className="text-sm text-red-800 dark:text-red-300">
            Couldn't load your scan inbox. Your items are still there.
          </div>
          <button
            type="button"
            onClick={() => void list.refetch()}
            className="mt-2 rounded-md border border-red-300 dark:border-red-700 px-3 py-1 text-sm text-red-800 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30"
          >
            Try again
          </button>
        </div>
      )}
      {/* Not empty while a receipt session is failed or being read: it has no
          rows, and it is the one thing on the page that needs a person. */}
      {!list.isLoading && !list.isError && items.length === 0 && Object.keys(rowlessSessions).length === 0 && (
        <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-8 text-center">
          <ScanLine size={28} className="mx-auto text-faint dark:text-slate-600 mb-2" />
          <div className="text-sm text-muted dark:text-slate-400">
            Nothing pending. Open the camera or add a UPC / photo above.
          </div>
          {/* The receipt door, in the open: one photo of a paper receipt puts
              the whole trip here. It lived only inside the "..." menu, which a
              phone in a grocery app never found (2026-09-02). */}
          <button
            type="button"
            data-testid="receipt-door"
            onClick={() => receiptRef.current?.click()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition"
          >
            <ReceiptText size={15} /> Photograph a receipt
          </button>
          <div className="text-xs text-faint dark:text-slate-500 mt-3">
            Got a USB or Bluetooth barcode scanner? Just point and scan - it lands
            here automatically, no need to open anything first.
          </div>
        </div>
      )}



      {/* The put-away front door on the page itself: a captured backlog is
          Guided Organize's native situation — ONE verb, preview-first
          (put-away.md §5). Live Sort lives where scanning starts instead. */}
      {viewMode !== "plan" &&
        ((scanStatsQ.data?.unfiled ?? 0) > 0 || (scanStatsQ.data?.ready ?? 0) > 0) && (
        // ONE line at every width: the count truncates before the button
        // moves. On a phone it was three lines and a large button, 82px
        // before the list had said anything (the owner, #2982).
        <div
          className="flex flex-row items-center gap-2 sm:gap-3 max-sm:text-[13px] max-sm:py-1.5 rounded-lg border border-cobble-400 dark:border-cobble-600 border-l-4 border-l-cobble-500 dark:border-l-cobble-400 bg-cobble-100 dark:bg-cobble-900 shadow-sm px-3 py-2.5 text-sm"
          data-testid="putaway-strip"
        >
          <span className="min-w-0 flex-1 truncate font-semibold text-content dark:text-mortar-100">
            <span className="mr-1.5">📦</span>
            <span className="hidden sm:inline">
              {[
                (scanStatsQ.data!.unfiled ?? 0) > 0
                  ? `${scanStatsQ.data!.unfiled} scanned item${scanStatsQ.data!.unfiled === 1 ? "" : "s"} without a home`
                  : null,
                (scanStatsQ.data!.ready ?? 0) > 0 ? `${scanStatsQ.data!.ready} ready to put away` : null,
              ]
                .filter(Boolean)
                .join(", and ")}
            </span>
            {/* The same two counts in fewer words on a phone. */}
            <span className="sm:hidden">
              {[
                (scanStatsQ.data!.unfiled ?? 0) > 0 ? `${scanStatsQ.data!.unfiled} without a home` : null,
                (scanStatsQ.data!.ready ?? 0) > 0 ? `${scanStatsQ.data!.ready} ready` : null,
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
            {/* One line on a phone: the count and the button; the reassurance
                is on the plan itself, which says nothing moves until confirmed. */}
            <span className="font-normal text-muted dark:text-slate-400 hidden sm:inline"> · preview first, nothing moves until you confirm</span>
          </span>
          <button
            type="button"
            onClick={() => setViewMode("plan")}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition shrink-0 max-sm:px-2.5 max-sm:py-1 max-sm:text-[13px]"
          >
            <span className="hidden sm:inline">Put them away</span><span className="sm:hidden">Put away</span>
          </button>
        </div>
      )}

      {/* Accepted and still to be put away (a walk left unfinished, or never
          started): offer the walk. Gone the moment nothing remains. */}
      {resumableWalk && !walkPlanId && (
        <button
          type="button"
          onClick={() => setWalkPlanId(resumableWalk.planId)}
          className="flex items-center gap-2 rounded-lg border border-accent/40 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2 text-sm text-accent hover:bg-cobble-100 dark:hover:bg-cobble-900/50 transition"
        >
          ▶ {resumableWalk.resumed ? "Resume put-away walk" : "Put-away walk"} - {resumableWalk.remaining} item
          {resumableWalk.remaining === 1 ? "" : "s"} left to place
        </button>
      )}

      {/* Bulk-triage toolbar — appears once anything is selected. Confirm routes
          each item to its own matchmaker top candidate; discard clears them out. */}
      {(selected.size > 0 || (visibleItems.length > 1 && allVisibleSelected)) && (
        <div className="sticky-under-header z-10 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-accent/40 bg-cobble-100 dark:bg-slate-800 shadow-md px-2.5 py-1.5 text-sm">
          {/* Opaque (was a /30 tint you could read the cards through) and tight:
              short labels + icon-only Discard/clear keep it to one action row on a
              phone instead of wrapping to three. */}
          <span className="font-medium text-content dark:text-mortar-100 whitespace-nowrap">{selected.size} sel.</span>
          <button
            type="button"
            onClick={() => setSelected(new Set(visibleItems.map((i) => i.id)))}
            className="text-xs text-accent hover:underline whitespace-nowrap"
          >
            all {visibleItems.length}
          </button>
          <span className="flex-1 min-w-[8px]" />
          {selected.size >= 2 && (
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => setOrganizeOpen(true)}
              title="Get a put-away plan for the selection: how these group, and which bins they belong in"
              className="rounded border border-accent/50 text-xs px-2 py-1 text-accent hover:bg-cobble-50 dark:hover:bg-cobble-900/30 transition disabled:opacity-50"
            >
              Organize
            </button>
          )}
          {hasLocations && (
            <button
              type="button"
              disabled={bulkBusy || selected.size === 0}
              onClick={() => setBulkLocOpen((o) => !o)}
              title="File the whole selection into a location"
              className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-600 text-xs px-2 py-1 text-content hover:bg-subtle dark:hover:bg-slate-700 transition disabled:opacity-50"
            >
              <MapPin size={13} className="shrink-0" /> Location
            </button>
          )}
          {(menu?.length ?? 0) > 0 && (
            <button
              type="button"
              disabled={bulkBusy || selected.size === 0}
              onClick={() => setBulkTargetOpen((o) => !o)}
              title="Commit the whole selection into one table"
              className="rounded border border-line dark:border-slate-600 text-xs px-2 py-1 text-content hover:bg-subtle dark:hover:bg-slate-700 transition disabled:opacity-50"
            >
              Add to…
            </button>
          )}
          <button
            type="button"
            disabled={bulkBusy || selected.size === 0}
            onClick={() => void bulkConfirm()}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
          >
            {bulkBusy ? "Working…" : "Confirm"}
          </button>
          <button
            type="button"
            disabled={bulkBusy || selected.size === 0}
            onClick={() => void bulkDiscard()}
            title="Discard the selection"
            aria-label="Discard the selection"
            className="rounded border border-line dark:border-slate-600 p-1 text-bad hover:bg-subtle dark:hover:bg-slate-700 transition disabled:opacity-50"
          >
            <Trash2 size={14} className="shrink-0" />
          </button>
          <button
            type="button"
            onClick={clearSelected}
            title="Clear selection"
            aria-label="Clear selection"
            className="rounded p-1 text-faint hover:text-content"
          >
            <X size={14} className="shrink-0" />
          </button>
          {bulkTargetOpen && (menu?.length ?? 0) > 0 && (
            <div className="w-full pt-1 flex flex-wrap gap-1.5">
              {menu!.map((entry) => (
                <button
                  key={`${entry.module}:${entry.instance ?? ""}:${entry.kind}`}
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void bulkAddAllTo(entry)}
                  className="rounded-full border border-line dark:border-slate-700 px-2.5 py-1 text-xs text-content hover:border-accent hover:text-accent transition disabled:opacity-50"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          {bulkLocOpen && (
            <div className="w-full pt-2 mt-1 border-t border-line/40 dark:border-slate-700/60">
              <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1.5">
                File the selection into
              </div>
              {/* Chips, not a dropdown — one tap files the whole selection into a
                  room or bin (the mobile pattern from the camera scanner). */}
              <LocationChipPicker value={null} onChange={(v) => v && void bulkApplyLocation(v)} />
            </div>
          )}
        </div>
      )}

      {organizeOpen && (
        <OrganizePlanSheet
          slug={activeSlug}
          itemIds={[...selected]}
          itemsById={new Map(items.map((i) => [i.id, i]))}
          open={organizeOpen}
          onClose={() => setOrganizeOpen(false)}
          onApplied={(filedIds) => {
            setSelected((s) => {
              const n = new Set(s);
              for (const id of filedIds) n.delete(id);
              return n;
            });
            void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
            void qc.invalidateQueries({ queryKey: ["organize-plan-latest", activeSlug] });
          }}
          onStartWalk={(planId) => void startWalk(planId)}
          renderItemCard={renderPlanItemCard}
        />
      )}

      {/* The pending-backlog plan is now the inline "Sorting plan" lens (see the
          header toggle + the list block above), not a modal. */}

      {organizeUnplacedOpen && (
        <OrganizePlanSheet
          slug={activeSlug}
          scope="unplaced"
          itemIds={[]}
          itemsById={new Map(items.map((i) => [i.id, i]))}
          open={organizeUnplacedOpen}
          onClose={() => setOrganizeUnplacedOpen(false)}
          onApplied={() => {
            void qc.invalidateQueries({ queryKey: ["organize-plan-latest", activeSlug] });
          }}
          onStartWalk={(planId) => {
            setOrganizeUnplacedOpen(false);
            void startWalk(planId);
          }}
          renderItemCard={renderPlanItemCard}
        />
      )}

      {intake.sheet}
      {fileEverything && (
        <FileEverythingSheet
          slug={activeSlug}
          batchId={fileEverything.batchId}
          defaultLocationId={fileEverything.defaultLocationId}
          scope={fileEverything.scope}
          onClose={() => setFileEverything(null)}
          onFiled={() => void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] })}
        />
      )}
      {showDuplicates && (
        <DuplicateRecordsSheet
          slug={activeSlug}
          locationName={(id) =>
            id ? ((locsQ.data?.items ?? []).find((l) => l.id === id)?.name ?? null) : null
          }
          onClose={() => setShowDuplicates(false)}
        />
      )}

      {liveSortOpen && (
        <LiveSortSheet
          slug={activeSlug}
          onClose={() => {
            setLiveSortOpen(false);
            void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
            void qc.invalidateQueries({ queryKey: ["scan-stats", activeSlug] });
          }}
        />
      )}

      {walkPlanId && (
        <OrganizeWalkSheet
          slug={activeSlug}
          planId={walkPlanId}
          itemsById={new Map(items.map((i) => [i.id, i]))}
          setFileBin={setFileBin}
          onClose={() => {
            setWalkPlanId(null);
            void qc.invalidateQueries({ queryKey: ["organize-plan-latest", activeSlug] });
          }}
        />
      )}

      {sessionActive && !batchId && !activeSessionInList && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-emerald-300/60 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/20 px-2.5 py-1.5 text-xs text-muted">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-content dark:text-mortar-100 font-medium">
            Scan session active
            {activeSession?.count ? ` — ${activeSession.count} item${activeSession.count === 1 ? "" : "s"}` : ""}
          </span>
          <span className="hidden sm:inline">· groups until 30 min idle</span>
          <span className="ml-auto inline-flex items-center gap-2 shrink-0">
            {activeSession?.batchId && (
              <Link
                to={`/scan?batch=${activeSession.batchId}`}
                className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
              >
                Review session
              </Link>
            )}
            <button
              type="button"
              onClick={() => {
                clearScanSession(activeSlug);
                toast.success("Session ended - the next scan starts a new one");
              }}
              className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
            >
              End session
            </button>
          </span>
        </div>
      )}

      {/* ── the LIST's own bar ───────────────────────────────────────────────
          How the list is grouped and how dense it is are properties OF THE
          LIST, so they sit with it rather than in the page header. That also
          takes four controls out of a row that had eighteen. */}
      {items.length > 0 && (
        <div className="flex items-center gap-2 text-xs -mb-1">
          {(unfiledCount > 0 || readyCount > 0) && (
            <HeaderMenu
              width={248}
              trigger={({ toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition"
                >
                  {viewMode === "plan" ? "Sorting plan" : "By session"}
                  <ChevronDown size={12} className="text-faint" />
                </button>
              )}
            >
              {({ close }) => (
                <>
                  <MenuHead>Group these {totalPending} by</MenuHead>
                  <MenuItem
                    label="Session"
                    hint="When you scanned them"
                    state={viewMode === "sessions" ? "on" : undefined}
                    onClick={() => {
                      setViewMode("sessions");
                      close();
                    }}
                  />
                  <MenuItem
                    label="Sorting plan"
                    hint="Where each one would go"
                    state={viewMode === "plan" ? "on" : undefined}
                    onClick={() => {
                      setViewMode("plan");
                      close();
                    }}
                  />
                </>
              )}
            </HeaderMenu>
          )}
          {/* How far the list is narrowed right now. Was a bare "12 / 69". */}
          {visibleItems.length !== items.length && (
            <span className="text-faint dark:text-slate-500">
              {visibleItems.length} of {items.length} shown
            </span>
          )}
          {/* Filtered to NOTHING: without this the list under "0 of 81 shown"
              was a blank void, and the tiny counter is easy to miss. One click
              back to everything. */}
          {items.length > 0 && visibleItems.length === 0 && (
            <button
              type="button"
              onClick={() => {
                setSearchQ("");
                setReviewOnly(false);
                setStaleOnly(false);
              }}
              className="rounded-md border border-line dark:border-slate-700 px-2 py-0.5 text-xs text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800"
            >
              nothing matches - clear filters
            </button>
          )}
          <span className="flex-1" />
          {/* On a phone the switch lives in the page menu (ScanInboxMenu),
              so this row holds only the grouping control. */}
          <div className="hidden sm:inline-flex items-center rounded-full border border-line dark:border-slate-700 p-0.5">
            {(
              [
                [false, <List key="l" size={12} />, "List"],
                [true, <LayoutGrid key="g" size={12} />, "Gallery - big photo tiles"],
              ] as const
            ).map(([grid, icon, label]) => (
              <button
                key={String(grid)}
                type="button"
                onClick={() => {
                  if (galleryView !== grid) toggleGalleryView();
                }}
                aria-pressed={galleryView === grid}
                title={label}
                className={
                  "rounded-full px-2 py-0.5 transition " +
                  (galleryView === grid
                    ? "bg-cobble-600 text-white"
                    : "text-muted dark:text-slate-400 hover:text-content")
                }
              >
                {icon}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {viewMode === "plan" && (unfiledCount > 0 || readyCount > 0) ? (
          // The sorting plan: the inbox re-expressed by DESTINATION. An inline
          // view swapped in by the header toggle (not a modal over the list) —
          // same pending items, grouped by where they should go.
          <>
          {/* Loud in-mode banner + an obvious way back. The tiny header toggle
              alone left users stranded here, wondering where their per-item
              fields + Confirm went (they're in "By session"). */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-content dark:text-mortar-100">You're in the Sorting plan</div>
              <div className="text-[11px] text-muted dark:text-slate-400">
                Scans grouped by where they'll go. To review and Confirm items one at a time, go back.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setViewMode("sessions")}
              className="shrink-0 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 py-1.5"
            >
              ‹ Back to items
            </button>
          </div>
          <SortingPlanView
            slug={activeSlug}
            scope="pending"
            itemIds={[]}
            itemsById={new Map(items.map((i) => [i.id, i]))}
            onApplied={() => {
              void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
              void qc.invalidateQueries({ queryKey: ["scan-stats", activeSlug] });
              void qc.invalidateQueries({ queryKey: ["organize-plan-latest", activeSlug] });
            }}
            onStartWalk={(planId) => void startWalk(planId)}
            onReviewItems={() => {
              // Land the user ON the unidentified items: back to the By-session
              // lens with the review-only filter armed, so a scan that "won't
              // sort" is one tap from being named. Only arm the filter when the
              // page can see review items — otherwise it'd hide everything with
              // no visible toggle to clear (that toggle only shows when
              // reviewCount > 0), stranding the user on an empty list.
              setReviewOnly(reviewCount > 0);
              setViewMode("sessions");
            }}
            renderItemCard={renderPlanItemCard}
          />
          </>
        ) : (
        <>
        {pendingScans.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-3 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-800/40 px-3 py-3"
          >
            <div className="w-10 h-10 rounded bg-black/10 dark:bg-white/5 shrink-0 flex items-center justify-center">
              <Loader2 size={16} className="animate-spin text-accent" />
            </div>
            <div className="min-w-0">
              <div className="font-medium text-content dark:text-mortar-100">Scanning…</div>
              <div className="text-[11px] font-mono text-faint truncate">{p.code}</div>
            </div>
          </div>
        ))}
        {/* The PWA's "Add photos" shortcut (and any link with ?pick=photos)
            lands here with the picker held out as one tap: a browser opens a
            file dialog only on a gesture, so the door is a button, not an
            auto-open (#3042). */}
        {pickPhotos && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2.5" data-testid="pick-photos-callout">
            <span className="text-sm text-content dark:text-mortar-100">Add photos from this device: they land here as one session and get identified.</span>
            <button
              type="button"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete("pick");
                setParams(next, { replace: true });
                fileRef.current?.click();
              }}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium"
            >
              <ImagePlus size={14} /> Add photos
            </button>
          </div>
        )}
        <SeriesBanner slug={activeSlug} items={visibleItems.filter((i) => i.status === "pending")} />
        {(() => {
          // Each card, with the combine offer injected just above the first item
          // of any cluster it belongs to (so the offer sits with its items).
          const card = (item: ScanInboxItem) => {
            const cluster = clusterByFirstId.get(item.id);
            return (
              <div
                key={item.id}
                id={`scan-item-${item.id}`}
                className={
                  highlightId === item.id
                    ? "rounded-lg ring-2 ring-accent ring-offset-2 ring-offset-surface dark:ring-offset-slate-950 transition"
                    : ""
                }
              >
                {cluster && combineBanner(cluster)}
                <InboxCard
                  item={item}
                  pageTarget={target}
                  menu={menu}
                  sessionCategoryLabel={sessionCategoryByItem.get(item.id) ?? null}
                  hasLocations={hasLocations}
                  selected={selected.has(item.id)}
                  onToggleSelect={() => toggleSelected(item.id)}
                  onArmBin={setFileBin}
                  onOpenSheet={(cand) => openSheet(item.id, cand)}
                  selectionActive={selected.size > 0}
                />
              </div>
            );
          };
          // Gallery view: a flat photo-tile grid for visual triage; a tap opens
          // the full card pre-expanded in a modal.
          if (galleryView) {
            return (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                {visibleItems.map((it) => (
                  <GalleryTile key={it.id} item={it} slug={activeSlug} onOpen={() => setGalleryFocusId(it.id)} />
                ))}
              </div>
            );
          }
          // Flat list when there's nothing to group by (scoped ?batch view).
          if (!showSessionHeaders) return visibleItems.map(card);
          // Otherwise a collapsible header per group: a real session shows its
          // time (· area); a day bucket shows the day. Both show a count.
          return sessionGroups.map((g, gi) => {
            const collapsed = collapsedSessions.has(g.key);
            const groupIds = g.items.map((i) => i.id);
            const allGroupSelected = groupIds.length > 0 && groupIds.every((gid) => selected.has(gid));
            // Merge target: the NEXT (older) group that is a real batch.
            const mergeInto = g.isBatch
              ? sessionGroups.slice(gi + 1).find((o) => o.isBatch && o.batchId)?.batchId ?? null
              : null;
            // How many items in this session are still being worked by the AI —
            // the one clear "is the whole session done thinking?" signal. Drives
            // the header control: "N finishing…" while any churn; once 0, it
            // becomes the "File all" button (routing is settled).
            // A failed read is not "finishing": the session's verdict says so
            // and its row says why (#2892).
            const busy = g.verdict.kind === "failed" ? 0 : g.items.filter((it) => itemEnriching(it)).length;
            // Pending items with a confident destination + a name — the ones
            // "File all" will commit to their own candidate. Pending items that
            // still need a manual look aren't counted here.
            // The session's one action and its words come from the row-state
            // resolver every row reads (scanSessionAction, #3076): the rows it
            // counts are the rows whose own button says Add or Install & add,
            // and the label says when filing installs a table.
            const sessionAction = scanSessionAction(g.items);
            const readyIds = sessionAction.ids;
            // Tables these items are routed to that the workspace does not have
            // yet. Filing installs them (see confirmItemsToTheirCandidate); the
            // tooltip says so, because installing a table is not something to
            // discover after the fact.
            const willInstallLabels = [
              ...new Set(
                g.items
                  .filter(isReadyToFile)
                  .map((it) => it.suggested_candidates?.[0] as { bundle_external_id?: string; label?: string } | undefined)
                  .filter((c) => c?.bundle_external_id)
                  .map((c) => c!.label ?? "a table"),
              ),
            ];
                const readyItems = g.items.filter(isReadyToFile);
                const filing = sessionFilingReadiness(readyItems, { activeBin: fileBin || null });
                // Filing into the standing bin without SAYING so is how the two
                // location controls got confusing - the copy names the place.
                const fallbackLoc = filing.fallbackLocation
                  ? (locsQ.data?.items ?? []).find((l) => l.id === filing.fallbackLocation)
                  : null;
                const fallbackClause =
                  filing.fallbackLocation && filing.missingLocation.length > 0
                    ? `; the ${filing.missingLocation.length} without a location go to ${fallbackLoc ? filingLabel(fallbackLoc) : "the set location"}`
                    : "";
                // Say where the suggested ones are about to go. Filing into a
                // spot the system worked out is right; doing it without saying
                // so is not - the person has to be able to see "6 into the
                // Fridge" BEFORE it happens, the same way the batch location is
                // named rather than applied quietly.
                // Merging is a write on somebody's behalf, so the button says
                // so before it is pressed rather than reporting it afterwards.
                const dupes = duplicateSummary(readyItems);
                const dupeClause = dupes.count
                  ? `; ${dupes.count} join what you already have (${dupes.names.slice(0, 3).join(", ")}${
                      dupes.names.length > 3 ? ", …" : ""
                    })`
                  : "";
                const placing = placementPreview(readyItems, filing.fallbackLocation);
                const placingClause = placing.placed.length
                  ? `; ${placing.placed
                      .map((p) => `${p.count} into ${p.name}`)
                      .join(", ")}${placing.unplaced > 0 ? `, ${placing.unplaced} with no spot yet` : ""}`
                  : "";
                const sessionLoc = sessionLocation(readyItems);
                const sessionLocName = sessionLoc.id
                  ? (locsQ.data?.items ?? []).find((l) => l.id === sessionLoc.id)
                  : null;
                // A category is only worth NAMING if the destination can hold
                // one. A Bookshelf table whose fields are isbn/genre/author has
                // no category axis, so `extrasWithCategory` writes the category
                // nowhere - while the button still promised "file all 1 into
                // Book" (reported 2026-08-01). Silence beats a filing that will not
                // happen; the items still file, just without the clause.
                const sessionHasCategoryAxis = readyItems.some((it) => !!categoryAxisKey(it, menu));
                const sessionCat = {
                  suggestion: sessionHasCategoryAxis ? filing.category : null,
                  unanimous: sessionCategory(g.items).unanimous,
                  seen: sessionCategory(g.items).seen,
                };
            const pendingInSession = g.items.filter((it) => it.status === "pending").length;
            // This group IS the live scanning session (localStorage) — so it
            // carries the "active" pulse + End control that used to live in the
            // now-suppressed green banner.
            const isActiveSession = sessionActive && g.isBatch && g.batchId === activeSession?.batchId;

            // ONE definition of "this session is a purchase", for every control
            // that only makes sense on one. An order number and a tracking
            // number are facts about something you BOUGHT; a burst of barcodes
            // off a shelf has neither. Each control used to spell its own gate
            // out, and the tracking number's said only `g.batchId` — so "+
            // Tracking #" sat on every scan session, including a barcode just
            // scanned (reported 2026-08-15). Two controls with the same meaning
            // and two hand-written gates is one gate waiting to be wrong.
            //
            // By LABEL rather than sourceFileId, deliberately: sessions from
            // before receipt originals were stored are still purchases. The
            // controls that need the stored FILE (Original, Re-parse) keep
            // gating on sourceFileId — that is a capability check, not this
            // question.
            const isReceiptSession = g.isBatch && !!g.batchId && !!g.label?.startsWith("Receipt");
            // What the receipt promised, for the parcel control's label. A live
            // carrier state outranks it there; this is what fills the usual gap
            // before any carrier has said anything.
            const trackingArrival = arrivalOf(g.items);
            return (
              <div key={g.key} id={g.batchId ? `s-${g.batchId}` : undefined} className="space-y-2 scroll-mt-24">
                {/* ONE row, always, and it FITS. No `flex-wrap`, no scrolling:
                    `overflow-hidden` clips a row that does not fit rather than
                    pushing the page sideways, so nothing may be allowed not to
                    fit.

                    A phone briefly got `overflow-x-auto` here instead. That was
                    dodging the decision - "I want it to all fit on mobile,
                    figure out what's most important, and then consolidate/drop
                    the rest" (the operator, 2026-08-31). Measured at 390px the
                    row wanted 629px of controls in 350px, so three things stand
                    down below sm, each because it is reachable somewhere better:

                      · the order number (134px) - it is IN the session when you
                        open it, and editable there
                      · the location chip (87px) - File all asks for a location
                        when the items need one, and the page header sets one
                      · the open arrow (43px) - the chevron beside the name
                        expands the same session in place

                    What stays is what the row is FOR: which session this is, is
                    something still coming, and file it. e2e/mobile-text-not-cut
                    fails if that ever stops fitting.

                    `data-session-header` is the anchor lint:scan-session-header
                    slices on. It used to find this row by the first
                    `"Set location"` in the file, which silently became the PAGE
                    header's chip once that label was made consistent everywhere
                    - so the lint reported all four utilities as misplaced when
                    nothing had moved. A structural anchor cannot be captured by
                    a string appearing somewhere else. */}
                {/* ONE ROW at every width. On a phone the row briefly wrapped
                    to three lines (core #2981, 2026-09-14) and the owner sent
                    it back the same day: "I really need the session header
                    to be one line" (#2982). So at 393px the identity (the
                    time or the receipt's label, the order number, the count)
                    folds into the name span and truncates before a control
                    ever wraps; the full label is the title and the open view.
                    The filing trio (location, file, open) stays last. */}
                <div
                  data-session-header
                  // gap-1.5, not gap-2: eleven gaps across this row, so the
                  // half-step is most of a control's width back.
                  className="flex w-full items-center gap-1.5 max-sm:gap-1 overflow-hidden rounded-md bg-mortar-50 dark:bg-slate-800/40 px-2.5 py-1.5 max-sm:px-1.5 max-sm:py-0 text-left text-xs"
                >
                  {/* Burst select-all: grab the whole session for the
                      bulk toolbar (location / confirm / discard). */}
                  <input
                    type="checkbox"
                    checked={allGroupSelected}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (allGroupSelected) groupIds.forEach((gid) => n.delete(gid));
                        else groupIds.forEach((gid) => n.add(gid));
                        return n;
                      })
                    }
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Select this whole session"
                    // Out to the left, clear of the chevron. It selects the whole
                    // SECTION, where everything after it acts on the row, and
                    // sitting flush against the chevron read as one cluster of
                    // two unrelated jobs.
                    className="shrink-0 -ml-1 mr-1 max-sm:ml-0 max-sm:mr-0 h-3.5 w-3.5 accent-cobble-600 cursor-pointer"
                  />
                  {/* The CHEVRON collapses, and nothing else does. The name
                      used to be inside the collapse button, so reading the
                      session's title and folding it away were the same gesture —
                      and a control that hides what you are reading when you tap
                      it is a control you learn to avoid. */}
                  <button
                    type="button"
                    onClick={() => toggleSession(g.key)}
                    aria-label={collapsed ? "Expand this session" : "Collapse this session"}
                    aria-expanded={!collapsed}
                    title={collapsed ? "Expand" : "Collapse"}
                    // Not on a phone (the owner, #2982: "the checkbox + the
                    // chevron... concerning"): there the identity itself is
                    // the tap that folds the session, 44px tall.
                    className="shrink-0 text-faint hover:text-accent transition max-sm:hidden"
                  >
                    <ChevronDown size={13} className={`transition ${collapsed ? "-rotate-90" : ""}`} />
                  </button>
                  {/* The word "Receipt" became this. It opened every receipt
                      row, said what the icon says, and cost width the row did
                      not have - and the icon can do the job the row was
                      spending a whole separate control on: tapping it opens the
                      original its lines were read from. Two elements out, one
                      in (2026-08-24). */}
                  {isReceiptSession &&
                    (g.sourceFileId ? (
                      // Hover shows the paper, click opens it - the one place on
                      // the row that stands for the receipt itself (2026-09-06).
                      <ReceiptPeek
                        slug={activeSlug}
                        fileId={g.sourceFileId}
                        onOpen={setViewSource}
                        title="Receipt - open the photo or file its lines were read from"
                        aria-label="Open the original receipt"
                        className="shrink-0 text-faint hover:text-accent transition"
                      >
                        <ReceiptText size={13} />
                      </ReceiptPeek>
                    ) : (
                      <span title="Receipt" aria-label="Receipt" className="shrink-0 text-faint">
                        <ReceiptText size={13} />
                      </span>
                    ))}
                    {/* The NAME wins the row. Every span after it either fits
                        whole or is not rendered - none of them truncate. A
                        `truncate` on the trimmings spends the same width to say
                        "edited ..." as to say "edited 3h ago", while squeezing
                        the one string that identifies the session down to
                        "Receipt · KC To..." (reported 2026-07-30). The full label is
                        always on the tooltip. */}
                    <SessionIdentity
                      handheld={handheld}
                      expanded={!collapsed}
                      onToggle={() => toggleSession(g.key)}
                      // The title takes what is left and is the LAST thing to
                      // give way. It used to be the only thing that gave way:
                      // it alone carried `truncate` while every control after it
                      // was shrink-0, so "Receipt · Lidl #141…" was clipped to
                      // make room for "+ Tracking #" (reported 2026-08-19). A
                      // session's name is the one thing on this row you cannot
                      // work out from anything else on it.
                      // Sized to the NAME, with nothing reserved. A min-width
                      // floor was added here to stop the name being crushed to
                      // "Recei...", and it did - but min-width also pads the box
                      // out when the name is SHORT, so "Lidl" sat in a 112px box
                      // and the row opened with a hole in it (2026-08-24).
                      //
                      // The floor is not needed any more: the row gave back
                      // ~127px when the parcel controls merged, so nothing is
                      // under shrink pressure at any width the desktop layout
                      // runs at. truncate + min-w-0 keeps it able to give way
                      // last if that ever stops being true.
                      className="font-medium text-content dark:text-mortar-100 truncate min-w-[4rem] sm:min-w-0 max-sm:flex-1 max-sm:basis-0 max-sm:min-w-0 max-sm:min-h-11 max-sm:text-left"
                      // The DATE is the session's identity; the word was
                      // boilerplate on every row of a view already called "By
                      // session", and truncation ate the date to keep it
                      // ("Session · Aug 1…" - the operator, 2026-08-30:
                      // "I would prioritize the date time over the word").
                      title={g.label ?? formatSessionTime(g.latest)}
                    >
                      {/* Without the order number — that is the control beside
                          it, so tapping the number edits it. */}
                      {sessionName(g, isReceiptSession) ?? formatSessionTime(g.latest)}
                      {/* PHONE ONLY: the rest of the identity, in the same
                          truncating span. The order number is still the
                          control it is beside the name from sm up. */}
                      <span className="sm:hidden font-normal text-faint">
                        {isReceiptSession && g.batchId && g.orderRef && editingPo !== g.batchId && <span className="font-medium text-muted"> · #{g.orderRef}</span>}
                        {g.verdict.kind !== "failed" && g.verdict.kind !== "in_flight" && ` · ${g.items.length} item${g.items.length === 1 ? "" : "s"}`}
                      </span>
                    </SessionIdentity>
                  {/* The receipt's own number, edited where it is READ. A separate
                      "PO#" control said the same thing twice: the number was
                      already in the name, and the pencil beside it was a second
                      way to reach it (reported 2026-08-20). */}
                  {isReceiptSession && g.batchId && g.orderRef && editingPo !== g.batchId && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPoInput(g.orderRef ?? "");
                        setEditingPo(g.batchId!);
                      }}
                      title="Edit the order / invoice number"
                      className="hidden sm:inline shrink-0 font-medium text-muted hover:text-accent transition"
                    >
                      #{g.orderRef}
                    </button>
                  )}
                  {/* ...and the offer to add one takes the SAME slot when there
                      is none. They are one fact in one place: an "+ #" sitting
                      over with the actions, while the number it creates appears
                      next to the name, made the two look like different things
                      (reported 2026-08-21). */}
                  {isReceiptSession && g.batchId && !g.orderRef && editingPo !== g.batchId && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPoInput("");
                        setEditingPo(g.batchId!);
                      }}
                      title="Add an order / invoice number, which tells two receipts from the same shop apart"
                      className="hidden sm:inline-flex shrink-0 items-center gap-1 text-faint hover:text-accent transition"
                    >
                      <Pencil size={11} /> + #
                    </button>
                  )}
                  {/* What this session IS, reading as one phrase beside its name
                      rather than scattered across the row. None of it collapses
                      the session any more: only the name does, which is the part
                      that looks like a heading. */}
                  {g.label && (
                      <span
                        className="hidden md:inline shrink-0 whitespace-nowrap text-faint"
                        // A receipt's date is the date ON THE RECEIPT. This said
                        // when the photo was uploaded, which is a fact about the
                        // scanning and not about the purchase — "Aug 19, 6:28 PM"
                        // beside a receipt dated the 18th (reported 2026-08-20).
                        // The upload time is still worth having, so it moves to
                        // the tooltip rather than the row.
                        title={
                          receiptDateOf(g)
                            ? [receiptDateWords(g.dateReading), `Uploaded ${formatSessionTime(g.latest)}`].filter(Boolean).join(" ")
                            : undefined
                        }
                      >
                        {g.origin === "email" ? "emailed " : ""}
                        {receiptDateOf(g) ?? formatSessionTime(g.latest)}
                      </span>
                    )}

                    {isActiveSession && (
                      <span
                        className="inline-flex items-center gap-1 shrink-0 text-emerald-600/80 dark:text-emerald-400/80"
                        title="The live scanning session - new scans keep grouping here until 30 min idle"
                      >
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        <span className="hidden sm:inline">active</span>
                      </span>
                    )}
                    {g.lastTouched - g.latest > 6 * 3600_000 && (
                      <span
                        className="hidden xl:inline-flex items-center gap-1 shrink-0 whitespace-nowrap text-faint"
                        title={`Edited ${timeAgo(new Date(g.lastTouched).toISOString())} - a later change (a fix, or an item sent back from a commit). The session's own time is unchanged.`}
                      >
                        <Pencil size={10} />
                        {timeAgo(new Date(g.lastTouched).toISOString())}
                      </span>
                    )}
                    {g.area && (
                      <span className="hidden lg:inline shrink-0 whitespace-nowrap text-muted">· {g.area}</span>
                    )}
                    {/* Left-aligned with the name and the date. These three say
                        WHAT this session is, so they read as one phrase; pushing
                        the count to the far right made it look like a control
                        (reported 2026-08-20). */}
                  {g.verdict.kind !== "failed" && g.verdict.kind !== "in_flight" && (
                    <span className="hidden sm:inline shrink-0 whitespace-nowrap text-faint">
                      {g.items.length} item{g.items.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {g.verdict.kind === "in_flight" && (
                    <SessionReadVerdict verdict={g.verdict} reading={false} onReadAgain={() => {}} configureAiHref={`/w/${activeSlug}/configuration/ai`} />
                  )}
                  {/* Everything after this is an ACTION, and actions sit right.
                      On a phone the spacer takes a whole line, so the controls
                      start the third. */}
                  <span className="flex-1 max-sm:hidden" />
                  {/* The session's action slot — its state used to be a passive
                      "All set" check that read as "committed" but only collapsed
                      the row on click (a user filed nothing and thought they had,
                      2026-07-16). Now: a real "File all" BUTTON once the AI is done,
                      committing every ready item to its own destination. */}
                  {isActiveSession && (
                    <button
                      type="button"
                      title="End this scan session - the next scan starts a new one"
                      onClick={() => {
                        clearScanSession(activeSlug);
                        toast.success("Session ended - the next scan starts a new one");
                      }}
                      className="shrink-0 text-faint hover:text-accent"
                    >
                      End
                    </button>
                  )}
                  {/* PER-SESSION UTILITIES sit LEFT of the filing trio.
                      The rightmost three controls are always location · file ·
                      open, whatever kind of session this is, so the eye lands on
                      the same place every row (reported 2026-07-30). These extras are
                      receipt-only, so leaving them on the right made the trio
                      shift column depending on whether a session came from a
                      receipt or a scan. */}
                  {/* Edit the order/invoice #. Purchase-only — see isReceiptSession. */}
                  {isReceiptSession &&
                    (editingPo === g.batchId ? (
                      <span
                        ref={poEditRef}
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0 inline-flex items-center gap-1"
                      >
                        <span className="text-faint">#</span>
                        <input
                          autoFocus
                          value={poInput}
                          onChange={(e) => setPoInput(e.target.value)}
                          onKeyDown={(e) => {
                            // The save button is disabled while pending; Enter
                            // must carry the same guard or held-Enter fires N
                            // identical PATCHes.
                            if (e.key === "Enter" && !setOrderRef.isPending) setOrderRef.mutate({ batchId: g.batchId!, orderRef: poInput.trim() || null });
                          }}
                          placeholder="order #"
                          // Sized to the number it is HOLDING. A fixed w-24 fits
                          // about eight characters, and a real order number is
                          // longer than that ("15026-52466"), so the value you
                          // came here to check was the part scrolled out of view.
                          // Grows with the content between a legible floor and a
                          // ceiling that cannot push the header row into overflow.
                          style={{ width: `${Math.min(24, Math.max(8, poInput.length + 2))}ch` }}
                          className="bg-transparent border-b border-cobble-400 dark:border-cobble-600 text-content dark:text-mortar-100 text-sm px-0.5 focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={setOrderRef.isPending}
                          onClick={() => setOrderRef.mutate({ batchId: g.batchId!, orderRef: poInput.trim() || null })}
                          className="text-accent hover:underline text-xs disabled:opacity-50"
                        >
                          save
                        </button>
                        <button type="button" onClick={() => setEditingPo(null)} className="text-faint hover:text-content text-xs">
                          ✕
                        </button>
                      </span>
                    ) : null)}
                  {/* Out on the row, not behind a glyph, and BEFORE the parcel
                      control: these two read the document, and following a parcel
                      or adding a number are things you do once. Rare last.

                      They were tucked into
                      a ... menu when the row was crowded, and the row is not
                      crowded any more: the name lost its duplicate number, the
                      date lost its clock, and filing lost a verb. A control you
                      can see is one you know exists. */}
                  {isReceiptSession && g.batchId && g.sourceFileId && (
                    <button
                      type="button"
                      disabled={reparse.isPending && reparseBatch === g.batchId}
                      onClick={(e) => {
                        e.stopPropagation();
                        reparse.mutate(g.batchId!);
                      }}
                      title="Read the original again, replacing the lines still pending"
                      aria-label="Read again"
                      // Off the queue's phone strip: a receipt-only tool made
                      // the strips differ session to session for no visible
                      // reason (the owner, #2982). It stays on the open view
                      // and beside a failed read's reason.
                      className={`${batchId ? "" : "max-sm:hidden "}shrink-0 inline-flex items-center gap-1 text-faint hover:text-accent transition disabled:opacity-50 max-sm:rounded-full max-sm:border max-sm:border-line/70 dark:max-sm:border-slate-700/70 max-sm:px-2 max-sm:py-1.5`}
                    >
                      <RotateCcw
                        size={11}
                        className={reparse.isPending && reparseBatch === g.batchId ? "animate-spin" : ""}
                      />{" "}
                      {/* A bordered icon chip on a phone, the same height as the
                          filing trio, so the one-line row keeps its name; the
                          word appears on a wide desk. The title and aria-label
                          say what it does at every width. */}
                      <span className="hidden 2xl:inline">Read again</span>
                    </button>
                  )}
                  {/* Tracking number — beside the order number because they
                      arrive together, off the same receipt, in the same glance.
                      And gated the same way, for the same reason: a parcel is
                      something a PURCHASE has.

                      The `|| g.trackingNumber` is not a loophole: a number
                      saved while the control was ungated has to stay editable
                      and clearable, or tightening the gate would strand it on a
                      session that can no longer reach it. */}
                  {/* Computed once: the truck control below reads it. */}
                  {/* A parcel is something an ORDER has. A till slip photographed in
                      the shop has no parcel, no order number and nothing on its
                      way, and "+ Tracking #" on a grocery receipt is a control
                      for a thing that cannot happen (2026-09-06). An emailed
                      order, an order number, a saved number or a known shipment
                      state each say there is something to follow. */}
                  {((isReceiptSession && (g.origin === "email" || !!g.orderRef || !!g.shipmentState)) ||
                    (!!g.batchId && !!g.trackingNumber)) &&
                    (editingTracking === g.batchId ? (
                      <span ref={trackingEditRef} className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          autoFocus
                          value={trackingInput}
                          onChange={(e) => setTrackingInput(e.target.value)}
                          onKeyDown={(e) => {
                            // Same pending guard the save button has - held
                            // Enter fired N identical PATCHes without it.
                            if (e.key === "Enter" && !setTracking.isPending)
                              setTracking.mutate({ batchId: g.batchId!, tracking: trackingInput.trim() || null });
                          }}
                          placeholder="tracking #"
                          // Same growing-field reasoning as the order number: a
                          // tracking number is 12 to 22 characters and the whole
                          // point is checking the one you just typed.
                          style={{ width: `${Math.min(26, Math.max(10, trackingInput.length + 2))}ch` }}
                          className="bg-transparent border-b border-cobble-400 dark:border-cobble-600 text-content dark:text-mortar-100 text-sm px-0.5 focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={setTracking.isPending}
                          onClick={() => setTracking.mutate({ batchId: g.batchId!, tracking: trackingInput.trim() || null })}
                          className="text-accent hover:underline text-xs disabled:opacity-50"
                        >
                          save
                        </button>
                        <button type="button" onClick={() => setEditingTracking(null)} className="text-faint hover:text-content text-xs">
                          ✕
                        </button>
                      </span>
                    ) : (
                      // The status hangs off this control rather than taking a
                      // line of its own. Where a parcel is belongs to the
                      // RECEIPT, so the header is the right area — but the
                      // header is already dense, and a permanent second line
                      // for a fact you check occasionally is a poor trade.
                      //
                      // On a PHONE it only appears when there is something to
                      // say: a number, a carrier state, or a promised date.
                      // Groceries you carried home have no parcel, and offering
                      // "+ Tracking #" on that receipt spent a third of the row
                      // on a question that does not apply ("a receipt does not
                      // need tracking", the operator, 2026-08-31). The offer
                      // stays from sm up, where the width is free, and adding a
                      // number is still possible inside the session.
                      <span
                        // Attached only to the OPEN one. A single ref across
                        // every receipt in the list would end up pointing at
                        // whichever rendered last, so clicking inside an open
                        // popover on any other row would count as "outside"
                        // and dismiss it.
                        ref={trackingPopover === g.batchId ? trackingPopRef : undefined}
                        // Always present now the menu is gone. With a number its
                        // label IS the delivery status; without one it offers to
                        // follow a parcel.
                        className={`relative shrink-0 ${
                          g.shipmentState || trackingArrival || g.trackingNumber
                            ? "inline-flex"
                            : "hidden sm:inline-flex"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            // Nothing to show without a number: go straight to
                            // the input rather than open an empty panel.
                            if (!g.trackingNumber) {
                              setTrackingInput("");
                              setEditingTracking(g.batchId!);
                              return;
                            }
                            // Measured from the button, because the panel is
                            // PORTALED out of this row - see below.
                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            // Clamped: the button sits near the row's right
                            // edge, so a raw r.left put most of the 256px panel
                            // past a phone's viewport.
                            setTrackingRect({
                              top: r.bottom + 6,
                              left: Math.max(8, Math.min(r.left, window.innerWidth - 256 - 8)),
                            });
                            setTrackingPopover(trackingPopover === g.batchId ? null : g.batchId!);
                          }}
                          aria-haspopup="dialog"
                          aria-expanded={trackingPopover === g.batchId}
                          title={
                            g.trackingNumber
                              ? "Where this parcel is, and the number"
                              : "Add a tracking number - the parcel is still on its way"
                          }
                          // Green once a number is set, so "is this one being
                          // followed?" is answerable by glancing down the column
                          // instead of reading each label for a leading +.
                          className={`inline-flex items-center gap-1 ${
                            g.trackingNumber
                              ? "text-emerald-600 dark:text-emerald-400 hover:text-emerald-500"
                              : "text-faint hover:text-accent"
                          }`}
                        >
                          <Truck size={11} />{" "}
                          {/* The label IS the status once there is one. The
                              header had no room for a second line, and a
                              control that says "Tracking #" next to a number
                              you cannot see is a label for a label. */}
                          {/* One control for the parcel, showing the best thing
                              known about it. A carrier's live state wins; the
                              receipt's own estimate fills the usual gap before
                              there is one; only with neither does it fall back
                              to offering the number.

                              These were two elements side by side - "arriving
                              tomorrow" and "+ Tracking #" - which is the row
                              spending twice to talk about one parcel, and it
                              was the pair that tipped the row into clipping
                              (2026-08-24). Tapping still adds a number, so the
                              estimate never costs you the ability to follow it. */}
                          {/* The same fact in two widths. A phone gets the
                              wording without the words the truck already says
                              - it is the last 21px the row needed to fit at
                              360px (measured 2026-08-31). */}
                          {/* Icon only below sm. The truck plus its colour still
                              says a parcel is in play and tapping opens the
                              panel with the carrier's own words; the label was
                              the widest thing left on the row, and the location
                              chip is worth more of that width ("location still
                              belongs in the session strip", 2026-09-01). */}
                          <span className="hidden sm:inline">
                            {g.shipmentState
                              ? (SHIPMENT_LABEL[g.shipmentState] ?? g.shipmentState)
                              : trackingArrival
                                ? arrivalLabel(trackingArrival)
                                : g.trackingNumber
                                  ? "Tracking #"
                                  : "+ Tracking #"}
                          </span>
                        </button>

                        {trackingPopover === g.batchId && g.trackingNumber && trackingRect &&
                          // PORTALED, and positioned from a measured rect. The
                          // session row is deliberately overflow-hidden so a row
                          // that does not fit is clipped rather than pushing the
                          // whole page sideways - which also clips anything
                          // absolutely positioned inside it, and this panel drew
                          // as a sliver under the row (reported 2026-08-24).
                          //
                          // The destination menu on the card solved exactly this
                          // and this is the same shape: fixed coordinates taken
                          // from the button, rendered to the body.
                          createPortal(
                          // Click, not hover: a phone has no hover, and this is
                          // the surface a phone user reaches for most.
                          <PopoverLayer
                            data-portal-panel
                            role="dialog"
                            aria-label="Parcel status"
                            onClick={(e) => e.stopPropagation()}
                            style={{ top: trackingRect.top, left: trackingRect.left }}
                            className="z-[61] w-64 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2.5 shadow-lg space-y-1.5 text-left"
                          >
                            {/* No state line: the button is already showing it.
                                This panel carries what would not fit there. */}
                            {!g.shipmentState && (
                              <div className="text-xs text-faint italic">Not checked yet</div>
                            )}
                            {/* The carrier's own wording is more specific than
                                our six states ("Arrived at FedEx location"). */}
                            {g.shipmentDescription && (
                              <div className="text-[11px] text-muted">{g.shipmentDescription}</div>
                            )}
                            {/* A scan location, not an address. Once delivered
                                it is usually the carrier's station, so showing
                                it there would claim something we cannot support;
                                in transit it honestly means how far it got. */}
                            {g.shipmentLocation && g.shipmentState !== "delivered" && (
                              <div className="text-[11px] text-faint">Last scanned {g.shipmentLocation}</div>
                            )}
                            <div className="font-mono text-[11px] text-faint break-all pt-0.5">
                              {g.trackingNumber}
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setTrackingPopover(null);
                                setTrackingInput(g.trackingNumber ?? "");
                                setEditingTracking(g.batchId!);
                              }}
                              className="text-[11px] text-accent hover:underline"
                            >
                              Edit number
                            </button>
                          </PopoverLayer>,
                          document.body,
                        )}
                      </span>
                    ))}

                  {/* A failed read, at a glance: the chip is the header's own
                      verdict and its Read again; the full sentence and the
                      connect link are in the body. Never "finishing…" (#2892). */}
                  {g.verdict.kind === "failed" && g.batchId && (
                    <SessionReadVerdict
                      compact
                      verdict={g.verdict}
                      reading={reparse.isPending && reparseBatch === g.batchId}
                      onReadAgain={() => reparse.mutate(g.batchId!)}
                      configureAiHref={`/w/${activeSlug}/configuration/ai`}
                    />
                  )}
                  {/* The session's PLACE, stated in the header rather than
                      discovered by pressing File. Filing needs a category and a
                      location; the category was already visible here while the
                      location only surfaced as a surprise question after the tap
                      (reported 2026-07-30). Now the missing half says so, and is one
                      tap from being set - set the location, then file. */}
                  {busy === 0 && readyIds.length > 0 && !fileBin && hasLocations && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPlacingMode("set");
                        setPlacingSession(placingSession === g.key ? null : g.key);
                      }}
                      title={
                        sessionLoc.mixed
                          ? "These are set to different places - tap to give the whole session one location"
                          : sessionLocName && sessionLoc.missing === 0
                          ? `All ${readyIds.length} are set to ${filingLabel(sessionLocName)} - tap to move them somewhere else`
                          : sessionLocName
                          ? `${readyIds.length - sessionLoc.missing} of ${readyIds.length} are in ${filingLabel(sessionLocName)}; the other ${sessionLoc.missing} have no location yet - tap to set it`
                          : `None of these ${readyIds.length} have a location yet - tap to set it`
                      }
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium ${
                        (sessionLocName && sessionLoc.missing === 0) ||
                        (sessionLoc.missing > 0 && sessionLoc.suggested === sessionLoc.missing)
                          ? "border-line/70 dark:border-slate-700/70 text-content dark:text-mortar-100 hover:border-cobble-400"
                          : "border-amber-400 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-900/25 text-amber-700 dark:text-amber-300 hover:border-amber-500"
                      }`}
                    >
                      <MapPin size={12} />
                      {sessionLoc.mixed ? (
                        <>
                          Mixed<span className="hidden sm:inline">&nbsp;locations</span>
                        </>
                      ) : sessionLoc.missing > 0 && sessionLoc.suggested === sessionLoc.missing ? (
                        // Every unplaced item has a suggested spot, and File all
                        // will use them. Amber "Location" over that read as
                        // "nothing has a home" (2026-09-06); this says what will
                        // actually happen.
                        <>
                          {sessionLoc.suggested}
                          <span className="hidden sm:inline">&nbsp;suggested</span>
                          <span className="sm:hidden">&nbsp;→</span>
                        </>
                      ) : sessionLocName && sessionLoc.missing === 0 ? (
                        filingLabel(sessionLocName)
                      ) : sessionLocName ? (
                        // PARTIAL. Naming the one location that IS set reads as
                        // the whole session's home, when most of it has nowhere
                        // to go - a session where 1 of 3 was placed showed a
                        // confident "White Bookshelf" (reported 2026-08-01). Lead
                        // with what is missing, because that is the thing left
                        // to do; `sessionLocation` has always returned the count
                        // and this is the render that finally reads it.
                        <>
                          {sessionLoc.missing} of {readyIds.length}
                          <span className="hidden sm:inline">&nbsp;need a location</span>
                        </>
                      ) : (
                        // It's a button: say the action, not the absence. Also
                        // the shortest honest label, which this row needs
                        // (reported 2026-08-01). "Set" went too: the pin
                        // already says it is a place, and the row needs the
                        // characters more than it needs the verb (2026-08-24).
                        // On a phone the pin alone (its title says the rest):
                        // the word cost the identity beside it its last
                        // characters (the owner, #2982).
                        <span className="max-sm:hidden">Location</span>
                      )}
                    </button>
                  )}
                  {/* The plan-first filer for this session: adds to what you
                      have where one thing matches, files the rest as new, leaves
                      the ambiguous. File all beside it still creates from each
                      card's candidate; folding the two is a follow-up. Hidden
                      while the AI is still deciding, like File all. */}
                  {busy === 0 && pendingInSession > 0 && g.isBatch && g.batchId && (
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        const first = g.items.find((it) => it.status === "pending");
                        setFileEverything({
                          batchId: g.batchId,
                          defaultLocationId: first?.target_location_id ?? (fileBin || null),
                          scope: g.sourceFileId ? "this receipt" : "this session",
                        });
                      }}
                      title="Shows a plan first: what gets added to things you already have, what is filed as new, what is left for you. Nothing is written until you confirm."
                      // Not on a phone's queue: the put-away strip above is the
                      // plan door for every session, and the File N dialog
                      // carries it per session ("Review the plan first"). The
                      // single-session page has no strip, so it keeps the button.
                      className={`${batchId ? "" : "max-sm:hidden "}shrink-0 inline-flex items-center gap-1 rounded-md border border-cobble-300 dark:border-cobble-700 hover:border-accent disabled:opacity-50 px-2 py-1 text-[11px] font-medium text-accent`}
                    >
                      {/* On a phone the label says what OPENS: a plan to review,
                          not a file. "File" beside "File 2" was the owner's own
                          finding (#2982): two doors with one word. */}
                      <Zap size={11} /> <span className="sm:hidden">Review plan</span><span className="hidden sm:inline">File everything</span>
                    </button>
                  )}
                  {busy > 0 ? (
                    <span
                      className="shrink-0 inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                      title="The AI is still finalizing some items - names, covers and routing may still change"
                    >
                      <Loader2 size={9} className="animate-spin" /> {busy} finishing…
                    </span>
                  ) : readyIds.length > 0 ? (
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        // No locations to pick from (module off, or none made
                        // yet) -> filing directly IS the answer. The old flow
                        // opened a picker showing "No locations yet" and made
                        // the user find the small "File without a location"
                        // link on every session, forever (2026-08-25 audit).
                        if (filing.reason === "location" && hasLocations) {
                          setPlacingMode("file");
                          setPlacingSession(g.key);
                        } else {
                          // fallbackLocation is why we are allowed to skip the
                          // prompt; not passing it is what filed items homeless.
                          void fileSession(readyIds, sessionCat.suggestion, filing.fallbackLocation);
                        }
                      }}
                      title={
                        // Says what the label CANNOT. It used to restate the
                        // label back at you ("...then files all 4"), which is
                        // the one thing you can already read (reported
                        // 2026-08-21). What is worth knowing is where they land
                        // and whether a table gets created on the way.
                        filing.reason === "location"
                          ? `Asks where they go first${
                              willInstallLabels.length ? `, and installs ${willInstallLabels.join(" and ")}` : ""
                            }`
                          : sessionCat.suggestion
                          ? `Add all ${readyIds.length} to their destinations, filed under “${sessionCat.suggestion}”${
                              sessionCat.unanimous
                                ? ""
                                : ` (the items suggested ${sessionCat.seen.join(", ")} - this files them as one)`
                            }${dupeClause}${placingClause}${fallbackClause}`
                          : `Each goes where the AI matched it${
                              willInstallLabels.length ? `, installing ${willInstallLabels.join(" and ")} on the way` : ""
                            }${dupeClause}${placingClause}${fallbackClause}`
                      }
                      className="shrink-0 inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 px-2 py-1 text-[11px] font-medium text-white"
                    >
                      {/* Say what the tap will DO. It used to read "File all 3
                          into Clothing" even when nothing had a location yet, so
                          it promised to file and then asked instead - the label
                          has to admit the question is coming (reported 2026-07-30). */}
                      {filing.reason === "location" ? (
                        <>
                          {/* The same verb as the other branch. The pin says
                              a location is still to be chosen; saying "Place &"
                              as well made one action look like two (reported
                              2026-08-20). Tapping it still opens the picker. */}
                          <MapPin size={11} />
                          {/* ONE text node. Each of these used to be its own
                              flex child, so the container's gap-1 landed between
                              "File", "all" and the count on top of the spaces
                              already in them — a visible double space
                              (reported 2026-08-21). */}
                          <span>
                            {bulkProgress ?? (
                              <>
                                <span data-testid="session-file">{sessionAction.label}</span>
                              </>
                            )}
                          </span>
                          {sessionCat.suggestion ? (
                            <span className="hidden sm:inline max-w-[9rem] truncate opacity-80">
                              as {sessionCat.suggestion}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <CheckCircle size={11} />
                          {/* ONE text node. Each of these used to be its own
                              flex child, so the container's gap-1 landed between
                              "File", "all" and the count on top of the spaces
                              already in them — a visible double space
                              (reported 2026-08-21). */}
                          <span>
                            {bulkProgress ?? (
                              <>
                                <span data-testid="session-file">{sessionAction.label}</span>
                              </>
                            )}
                          </span>
                          {sessionCat.suggestion ? (
                            // "as", the same word the other branch uses. The two
                            // said "as Mugs" and "into Figurine" for the very
                            // same thing — the CATEGORY these get filed as — so
                            // the pair read like two different operations when
                            // the only real difference is whether it still has
                            // to ask you where (reported 2026-08-20).
                            <span className="hidden sm:inline max-w-[9rem] truncate opacity-80">
                              as {sessionCat.suggestion}
                            </span>
                          ) : null}
                        </>
                      )}
                    </button>
                  ) : pendingInSession > 0 ? (
                    <span
                      className="shrink-0 inline-flex items-center gap-1 text-amber-600/80 dark:text-amber-400/80 text-[10px] font-medium"
                      title="Every item still here needs a manual look - open the cards to give each a name or destination"
                    >
                      needs review
                    </span>
                  ) : g.verdict.kind === "failed" || g.verdict.kind === "in_flight" ? null : (
                    // No rows because they were all filed; never because the
                    // read failed (that session's chip says so) or is running.
                    <span
                      className="shrink-0 inline-flex items-center gap-1 text-emerald-600/70 dark:text-emerald-400/70 text-[10px]"
                      title="Every item in this session has been filed"
                    >
                      <CheckCircle size={11} /> filed
                    </span>
                  )}
                  {/* Not when we ARE that page (?batch): it would link to where
                      you already are. The only control in this row that a
                      single-session view has to drop — the rest either apply
                      unchanged or already withhold themselves (Merge needs an
                      older session to fold into, and finds none). */}
                  {g.isBatch && g.batchId && !batchId && (
                    <Link
                      to={`/scan?batch=${g.batchId}`}
                      title="Review just this session"
                      // At every width: on a phone the controls have a line of
                      // their own now, so the link no longer has to stand down.
                      aria-label="Open this session"
                      className="shrink-0 text-faint hover:text-accent"
                    >
                      {/* The bare arrow on a phone, the word from sm up. The
                          phone span comes first so the sm span's "open →"
                          stays the last text in the bar (the lint's anchor). */}
                      <span className="sm:hidden">→</span>
                      <span className="max-sm:hidden">open →</span>
                    </Link>
                  )}
                </div>
                {!collapsed && (
                  <div className="space-y-2">
                    {/* The read's verdict, in the session's own words: a failed
                        read says why, with a Read again you can see and the
                        connect link when a provider is the reason (#2892). The
                        compact chip in the header bar says the same at a glance. */}
                    {g.verdict.kind === "failed" && g.batchId && (
                      <SessionReadVerdict
                        verdict={g.verdict}
                        reading={reparse.isPending && reparseBatch === g.batchId}
                        onReadAgain={() => reparse.mutate(g.batchId!)}
                        configureAiHref={`/w/${activeSlug}/configuration/ai`}
                      />
                    )}
                    {g.items.map(card)}
                    {/* Merge lives INSIDE the expanded session (reveal-to-use),
                        not on the collapsed header where its old ↓ was mistaken
                        for the accordion and folded sessions by accident. It's a
                        rare re-unify action; every merge is Undo-able via toast. */}
                    {/* A receipt is already one group; asking whether its
                        lines belong together is noise (2026-09-06). */}
                    {g.batchId && !g.items.every((i) => i.source_kind === "receipt") && (
                      <SessionTheme
                        slug={activeSlug}
                        batchId={g.batchId}
                        itemCount={g.items.filter((i) => i.status === "pending").length}
                      />
                    )}
                    {mergeInto && g.batchId && (
                      <div className="pt-0.5">
                        <button
                          type="button"
                          title="Two bursts that are really one job? Moves these rows into the previous (older) session. Only which session they sit in changes: nothing is combined and nothing filed changes. You can undo it."
                          onClick={() =>
                            void mergeBatches.mutateAsync({ from: g.batchId!, into: mergeInto, itemIds: groupIds })
                          }
                          disabled={mergeBatches.isPending}
                          className="text-xs text-faint hover:text-accent disabled:opacity-50"
                        >
                          Move into the previous session
                        </button>
                      </div>
                    )}
                  </div>
                )}

              {/* Filing needs a place as well as a category. Opened from the
                  header chip it only SETS the location (set, then file - two
                  deliberate steps); opened from the File button it sets and
                  files in one go, because that button already promised to. */}
              <SessionLocationModal
                open={placingSession === g.key}
                mode={placingMode}
                count={readyIds.length}
                category={filing.category}
                currentLocationId={sessionLoc.id}
                onPick={(v) => {
                  setPlacingSession(null);
                  if (placingMode === "set")
                    // Fill only items with no location when the set is MIXED -
                    // the modal opened with no current value then, and a blanket
                    // write would flatten every per-item choice silently.
                    void applySessionLocation(readyIds, v, sessionLoc.mixed);
                  else void fileSession(readyIds, filing.category, v);
                }}
                onFileWithoutLocation={() => {
                  setPlacingSession(null);
                  void fileSession(readyIds, filing.category, null);
                }}
                onReviewPlan={
                  g.isBatch && g.batchId
                    ? () => {
                        setPlacingSession(null);
                        const first = g.items.find((it) => it.status === "pending");
                        setFileEverything({
                          batchId: g.batchId!,
                          defaultLocationId: first?.target_location_id ?? (fileBin || null),
                          scope: g.sourceFileId ? "this receipt" : "this session",
                        });
                      }
                    : undefined
                }
                onClose={() => setPlacingSession(null)}
              />
              </div>
            );
          });
        })()}
        {/* Infinite-scroll sentinel — pulls the next page as it nears the view. */}
        {hasNextPage && (
          <div ref={loadMoreRef} className="py-4 text-center text-xs text-faint">
            {isFetchingNextPage ? "loading more…" : ""}
          </div>
        )}
        </>
        )}
      </div>

      {wedgeBinAdjust && (
        <BinAdjustModal
          locationId={wedgeBinAdjust.locationId}
          locationName={wedgeBinAdjust.locationName}
          item={wedgeBinAdjust.item}
          onClose={() => setWedgeBinAdjust(null)}
          onAddSomethingElse={() => {
            setFileBin(wedgeBinAdjust.locationId);
            toast.success(`Filing into ${wedgeBinAdjust.locationName} — scan the new item`);
            setWedgeBinAdjust(null);
          }}
        />
      )}
      {/* The item sheet: the full triage card, pre-expanded, on its own, with
          previous/next through the queue as it is on screen. */}
      {galleryFocusId &&
        (() => {
          const focus = items.find((i) => i.id === galleryFocusId);
          if (!focus) return null;
          const queue = visibleItems.filter((i) => i.status === "pending");
          const at = queue.findIndex((i) => i.id === focus.id);
          // Triage rip-through: once this item resolves, advance the
          // sheet to the NEXT pending item instead of showing a stale card.
          if (focus.status !== "pending") {
            const next = queue.find((i) => i.id !== focus.id);
            if (next) setTimeout(() => openSheet(next.id), 0);
            else setTimeout(() => setGalleryFocusId(null), 0);
            return null;
          }
          const prev = at > 0 ? queue[at - 1] : undefined;
          const next = at >= 0 && at < queue.length - 1 ? queue[at + 1] : undefined;
          return (
            <Modal open onClose={() => setGalleryFocusId(null)} size="lg" fillHeight flush stickyFooter>
              <InboxCard
                key={focus.id}
                item={focus}
                pageTarget={target}
                menu={menu}
                sessionCategoryLabel={sessionCategoryByItem.get(focus.id) ?? null}
                hasLocations={hasLocations}
                defaultExpanded
                defaultCand={focusCand}
                onArmBin={setFileBin}
                sheet={{
                  index: at < 0 ? 0 : at,
                  total: queue.length,
                  onPrev: prev ? () => openSheet(prev.id) : null,
                  onNext: next ? () => openSheet(next.id) : null,
                  onClose: () => setGalleryFocusId(null),
                }}
              />
            </Modal>
          );
        })()}

      {recentlyDeleted.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowDeleted((s) => !s)}
            className="flex items-center gap-1.5 text-xs text-faint hover:text-muted"
          >
            <ChevronDown size={13} className={`transition ${showDeleted ? "rotate-180" : ""}`} />
            Recently deleted ({recentlyDeleted.length})
          </button>
          {showDeleted && (
            <div className="mt-2 space-y-1.5">
              {recentlyDeleted.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center gap-2 rounded-md border border-line dark:border-slate-700 bg-surface/50 dark:bg-slate-800/30 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-muted truncate">
                      {displayName(d) ?? d.barcode_text ?? "Unknown scan"}
                    </div>
                    {d.barcode_text && displayName(d) && (
                      <div className="text-[10px] font-mono text-faint truncate">{d.barcode_text}</div>
                    )}
                    {!!(d.suggested_metadata as { split_undone_at?: string } | null)?.split_undone_at && (
                      <div className="text-[10px] font-mono text-faint truncate">✂ piece of a split that was undone; the group photo is back in the inbox</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => restore.mutate(d.id)}
                    disabled={restore.isPending}
                    className="shrink-0 inline-flex items-center gap-1 text-xs rounded border border-line px-2 py-1 text-muted hover:text-content disabled:opacity-50"
                  >
                    <RotateCcw size={12} /> Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {recentlyCommitted.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowCommitted((s) => !s)}
            className="flex items-center gap-1.5 text-xs text-faint hover:text-muted"
          >
            <ChevronDown size={13} className={`transition ${showCommitted ? "rotate-180" : ""}`} />
            Recently committed ({recentlyCommitted.length})
          </button>
          {showCommitted && (
            <div className="mt-2 space-y-1.5">
              <p className="text-[11px] text-faint">
                Committed the wrong thing? Send it back: the scan returns to the inbox to redo, and
                the entry it created is removed (an entry it merely updated is left alone).
              </p>
              {committedGroups.map((grp) =>
                grp.batchId && grp.items.length > 1 ? (
                  <div key={grp.key} className="rounded-md border border-line dark:border-slate-700 bg-surface/50 dark:bg-slate-800/30">
                    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line/70 dark:border-slate-700/70">
                      <span className="text-xs text-muted">
                        {grp.items.length} item{grp.items.length === 1 ? "" : "s"} from one session
                      </span>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() =>
                          void sendBackSession(
                            grp.key,
                            grp.batchId,
                            grp.items.map((i) => i.id),
                          )
                        }
                        disabled={sendingBackAll === grp.key}
                        className="shrink-0 inline-flex items-center gap-1 text-xs rounded border border-line px-2 py-1 text-muted hover:text-content disabled:opacity-50"
                      >
                        <RotateCcw size={12} className={sendingBackAll === grp.key ? "animate-spin" : ""} /> Send whole session back
                      </button>
                    </div>
                    {grp.items.map((d) => (
                      <div key={d.id} className="flex items-center gap-2 px-3 py-1.5 pl-6">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-muted truncate">{displayName(d) ?? d.barcode_text ?? "Unknown scan"}</div>
                          {splitPieces(d) ? (
                            <div className="text-[10px] font-mono text-faint truncate">✂ split into {splitPieces(d)} items</div>
                          ) : (
                            <CommittedDestination item={d} tables={destinationTables} />
                          )}
                        </div>
                        {splitPieces(d) ? (
                          <button
                            type="button"
                            onClick={() => undoSplit.mutate(d.id)}
                            disabled={undoSplit.isPending || sendingBackAll === grp.key}
                            className="shrink-0 text-xs text-faint hover:text-content disabled:opacity-50"
                          >
                            Undo split
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => unconfirm.mutate(d.id)}
                            disabled={unconfirm.isPending || sendingBackAll === grp.key}
                            className="shrink-0 text-xs text-faint hover:text-content disabled:opacity-50"
                          >
                            Send back
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  grp.items[0] && (
                    <div
                      key={grp.key}
                      className="flex items-center gap-2 rounded-md border border-line dark:border-slate-700 bg-surface/50 dark:bg-slate-800/30 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-muted truncate">
                          {displayName(grp.items[0]) ?? grp.items[0].barcode_text ?? "Unknown scan"}
                        </div>
                        {splitPieces(grp.items[0]) ? (
                          <div className="text-[10px] font-mono text-faint truncate">✂ split into {splitPieces(grp.items[0])} items</div>
                        ) : (
                          <CommittedDestination item={grp.items[0]} tables={destinationTables} />
                        )}
                      </div>
                      {splitPieces(grp.items[0]) ? (
                        <button
                          type="button"
                          onClick={() => undoSplit.mutate(grp.items[0]!.id)}
                          disabled={undoSplit.isPending}
                          className="shrink-0 inline-flex items-center gap-1 text-xs rounded border border-line px-2 py-1 text-muted hover:text-content disabled:opacity-50"
                        >
                          <RotateCcw size={12} /> Undo split
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => unconfirm.mutate(grp.items[0]!.id)}
                          disabled={unconfirm.isPending}
                          className="shrink-0 inline-flex items-center gap-1 text-xs rounded border border-line px-2 py-1 text-muted hover:text-content disabled:opacity-50"
                        >
                          <RotateCcw size={12} /> Send back
                        </button>
                      )}
                    </div>
                  )
                ),
              )}
            </div>
          )}
        </div>
      )}

      {batchAsk && (
        <Modal
          open
          onClose={() => batchAsk.resolve(null)}
          title={`${batchAsk.groups.reduce((n, g) => n + g.count, 0)} of these may belong somewhere else`}
          size="sm"
        >
          <div className="space-y-2">
            <p className="text-xs text-muted dark:text-slate-400">
              Tick the tables you agree with - anything unticked keeps its
              current routing. Closing this files nothing.
            </p>
            {batchAsk.groups.map((g) => (
              <label
                key={g.instance}
                className="flex items-start gap-3 rounded-md border border-line dark:border-slate-700 p-3 cursor-pointer hover:border-cobble-300 dark:hover:border-cobble-700 transition"
              >
                <input
                  type="checkbox"
                  checked={batchAccepted.has(g.instance)}
                  onChange={() =>
                    setBatchAccepted((prev) => {
                      const next = new Set(prev);
                      if (next.has(g.instance)) next.delete(g.instance);
                      else next.add(g.instance);
                      return next;
                    })
                  }
                  className="mt-0.5 h-4 w-4 shrink-0 accent-cobble-600"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-content dark:text-mortar-100">
                    {g.count} → {g.label}
                  </span>
                  <span className="block text-xs text-muted dark:text-slate-400 truncate">{g.sample}</span>
                </span>
              </label>
            ))}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => batchAsk.resolve(new Set())}
                className="rounded border border-line dark:border-slate-600 px-3 py-1.5 text-xs text-muted hover:text-content transition"
              >
                File all as-is
              </button>
              <button
                type="button"
                onClick={() => batchAsk.resolve(new Set(batchAccepted))}
                className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-xs font-medium transition"
              >
                File
              </button>
            </div>
          </div>
        </Modal>
      )}
      <ScanImportModal
        slug={activeSlug}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] })}
      />
      {exportOpen && (
        <ExportInboxModal
          slug={activeSlug}
          items={items.map((i) => ({ id: i.id, name: displayName(i) ?? "" }))}
          preselectedIds={[...selected]}
          onClose={() => setExportOpen(false)}
        />
      )}
      {viewSource && (
        <ReceiptSourceViewer
          slug={activeSlug}
          fileId={viewSource}
          money={viewSourceMoney?.money ?? null}
          soldBy={viewSourceMoney?.soldBy ?? null}
          onClose={() => setViewSource(null)}
        />
      )}
    </div>
  );
}

// ── the UPC entry modal — deliberately tiny ───────────────────────────
// One input row + one hint line. Stays open after each add for rapid
// fire (a physical scan gun types a code + Enter; the input refocuses
// after every submit). Upload and Camera act directly from the header —
// this modal exists only because typing needs a keyboard.

// Bulk URL intake: paste product URLs (one per line) — each becomes an inbox item
// enriched through the URL path (vendor resolver → web search). For cataloging an
// order/wishlist without a barcode.

// ── one inbox item: an accordion triage card ──────────────────────────
// Collapsed: the at-a-glance match (thumb, name, one-tap table chips).
// Expanded: catalog vs YOUR photo, the AI's reasoning + confidence,
// sanity-check links, and the inline confirm form. A matchmaker chip
// expands straight into that table's form, fields pre-filled.
// ── "Turn into a bin": scan → location, one shot ─────────────────────
// The scanned product IS a container (a storage tote). One action: create a
// core-locations bin (kind "container"), write the scan's product identity +
// photo onto it (the existing confirm-into-location seam), and optionally arm
// it as the standing file-bin so the very next scans land inside it. The bin
// NAME is the user's label ("Bin 17" auto-suggested from what exists); the
// product name rides underneath as its identity, never as its name.
function receiptDateOf(g: { items: ScanInboxItem[] }): string | null {
  for (const it of g.items) {
    const d = (it.suggested_metadata as { receipt_date?: unknown } | null)?.receipt_date;
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    // Parsed as a plain date, not a timestamp: `new Date("2026-08-18")` is UTC
    // midnight, which renders as the 17th anywhere west of Greenwich.
    const [y, m, day] = d.split("-").map(Number);
    return new Date(y!, m! - 1, day!).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return null;
}

/** A session's name WITHOUT its order number. The number is rendered beside it
 *  as its own control so it can be edited where it is read, and the two would
 *  otherwise both show it: "Receipt · Lidl #141483 #141483". */
function sessionName(
  g: { label?: string | null; orderRef?: string | null },
  /** True when the row renders the receipt ICON, which says "receipt" already.
   *  The word then costs width twice over on a row that has none to spare. */
  iconSaysReceipt = false,
): string | null {
  const label = g.label ?? null;
  if (!label) return label;
  // By SHAPE, and ALWAYS — not only when a ref is stored. The two can disagree:
  // a label built before the number was edited, a ref of "141483" against a
  // label reading "#141483/02", or a ref later cleared while the label kept its
  // suffix. Stripping only when a ref exists meant a cleared one showed the old
  // number in the name AND a "+ #" offering to add one, which contradict.
  // `order_ref` is the source of truth; the label is a rendering of it.
  // receiptSessionLabel only ever appends " #<ref>", so the shape is exact.
  const withoutRef = label.replace(/\s+#\S+$/, "");
  // "Receipt · Best Buy" -> "Best Buy". Only the prefix receiptSessionLabel
  // writes, and only when the icon is there to say it instead; a session whose
  // name happens to start with the word keeps it.
  return iconSaysReceipt ? withoutRef.replace(/^Receipt\s+·\s+/, "") : withoutRef;
}

// Session-theme banner: after a batch, offer to TAG everything with a derived
// theme + suggest a CATEGORY for the non-media subset — e.g. "these 6 things →
// tag 'Camping', category 'Camp Cookware' on the 2 pots, leaving the 4 books
// tagged but uncategorized." Nothing hardcoded; derived server-side, degrades to nothing.
/**
 * "Do these belong together?" - asked about ONE session, and only when asked.
 *
 * This used to run on every inbox load: a chat call per load, keyed on the
 * pending count so every scan re-fired it, reading the 50 most recent pending
 * items in the WHOLE workspace and rendering inside whatever the person had
 * filtered to. A view of two humidifiers was offered a grocery category "to 50
 * of them" - two populations in one sentence - and Apply would have stamped 50
 * rows that were not on screen (2026-09-03).
 *
 * Now it is a link inside the expanded session, beside Merge: nothing runs
 * until someone presses it, it asks only about that session, and both numbers
 * in the sentence come from the same set of items.
 */
function SessionTheme({ slug, batchId, itemCount }: { slug: string; batchId: string; itemCount: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [asked, setAsked] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const theme = useQuery({
    queryKey: ["scan-session-theme", slug, batchId],
    queryFn: () => api.scanSessionTheme(slug, batchId),
    // ASKED, never assumed. `enabled` stays false until the press, so opening
    // the inbox costs nothing.
    enabled: asked && !dismissed,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
  const apply = useMutation({
    mutationFn: () =>
      api.applyScanTheme(slug, {
        ...(theme.data?.tag ? { tag: theme.data.tag, tag_item_ids: theme.data.tag_item_ids } : {}),
        ...(theme.data?.category ? { category: theme.data.category } : {}),
      }),
    onSuccess: (r) => {
      toast.success(
        `Tagged ${r.tagged}${r.categorized ? ` · categorised ${r.categorized}` : ""} - applied when you confirm each.`,
      );
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      setDismissed(true);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't apply that."),
  });
  if (dismissed || itemCount < 2) return null;
  if (!asked) {
    return (
      <div className="pt-0.5">
        <button
          type="button"
          onClick={() => setAsked(true)}
          title="Ask whether these scans share a tag or a category. Nothing runs until you press this."
          className="text-xs text-faint hover:text-accent"
        >
          Do these {itemCount} belong together?
        </button>
      </div>
    );
  }
  if (theme.isFetching) return <div className="pt-0.5 text-xs text-faint">Reading the {itemCount}…</div>;
  const t = theme.data;
  if (!t || (!t.tag && !t.category)) {
    return (
      <div className="pt-0.5 text-xs text-faint">
        Nothing these {itemCount} obviously share.{" "}
        <button type="button" onClick={() => setDismissed(true)} className="underline hover:text-content">
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <div className="pt-0.5 rounded-lg border border-cobble-300 dark:border-cobble-700/60 bg-cobble-50/70 dark:bg-cobble-950/20 px-3 py-2.5 flex items-center gap-3">
      <Sparkles size={15} className="text-accent shrink-0" />
      <div className="min-w-0 flex-1 text-sm text-content dark:text-mortar-100">
        {/* Both counts come from THIS session now, so they cannot disagree - and
            "these look related" is only said when a tag was actually found to
            relate them. With a category alone, nothing was: some of them merely
            share a kind, which is a smaller claim and the one worth making. */}
        {t.tag ? (
          <>
            These {itemCount} look related. Tag each of them <strong>"{t.tag}"</strong>? A tag on each row; nothing is combined.
            {t.category ? (
              <span className="text-muted">
                {" "}
                Also add category <strong>"{t.category.value}"</strong>
                {t.category.item_ids.length === itemCount ? " to all of them" : ` to ${t.category.item_ids.length} of them`}.
              </span>
            ) : null}
          </>
        ) : t.category ? (
          <>
            {t.category.item_ids.length === itemCount ? `All ${itemCount}` : `${t.category.item_ids.length} of these ${itemCount}`} look like{" "}
            <strong>"{t.category.value}"</strong>. Add that category to each? A field on each row; nothing is combined.
          </>
        ) : null}
      </div>
      <button
        type="button"
        disabled={apply.isPending}
        onClick={() => apply.mutate()}
        className="shrink-0 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
      >
        {apply.isPending ? "Applying…" : t.tag ? "Tag them" : "Add the category"}
      </button>
      <button type="button" onClick={() => setDismissed(true)} className="shrink-0 text-faint hover:text-content p-1" title="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

// The target picker lists the workspace's ACTUAL tables (instances like
// "Yarn" + each enabled module's default), straight from the same menu
// the matchmaker prompts with — the web hardcodes no module names (core
// tenet). Picking a table renders THAT table's fields, pre-seeded from
// the matchmaker's extraction when a chip routed here.
