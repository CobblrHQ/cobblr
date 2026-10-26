import { ScanInboxEmptyState } from "./ScanInboxEmptyState";
import { ActiveScanSessionNotice } from "./ActiveScanSessionNotice";
import { ReadPersonalDocumentModal } from "../components/PersonalDocumentReader";
import { SplitLineGroup } from "../components/SplitLineGroup";
import { splitLayoutOf, type SplitParent } from "../lib/splitLayout";
import { ScanningInBanner } from "../components/OrderLineUnits";
import { useScanOrigins } from "../lib/useScanOrigins";
// /scan — the inbox review queue, photo-inbox-grade.
import { createPortal } from "react-dom";
import { FileEverythingSheet } from "../components/FileEverythingSheet";
import { ScanSessionTheme } from "../components/ScanSessionTheme";
import { SessionMetaLine, SessionOrderRef } from "./SessionOrderLine";
import { SessionPlaceChip } from "../components/SessionPlaceChip";
import { SessionHeadline } from "../components/SessionHeadline";
import { SCAN_PICKER_ACCEPT, ScanPickerInput, useScanIntake } from "../components/ScanPhotoPicker";
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
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle, ChevronDown, ExternalLink, Image as ImagePlus, LayoutGrid, List, Loader2, Mail, MapPin, MonitorSmartphone, Pencil, ReceiptText, RotateCcw, ScanLine, Search, Sparkles, Tag, Trash2, Truck, X, Zap, MoreHorizontal, Undo2 } from "lucide-react";
import { editOf, useLater, useTickedRows, useAskCobbAboutSelection, Modal, useToast, usePageTitle, PopoverLayer, OverlayLayer, relativeTime, TILE_GRID, useEscapeToClose, useCloseOnPageScroll } from "@cobblr/platform-web";
import { ScanImportModal } from "../components/ScanImportModal";
import { ExportInboxModal } from "../components/ExportInboxModal";
import { } from "../components/CameraCaptureSheet";
import { } from "../panels/registry";
import { LocationChipPicker } from "../components/LocationChipPicker";
import { SessionLocationModal } from "../components/SessionLocationModal";
import { committedGroupsOf, sendBackIdsOf } from "../lib/committedGroups";
import { placeForFilingLine, sessionPlaceSuggestion, suggestedPlaceNames, suggestedPlaces } from "../lib/sessionPlaceSuggestion";
import { OrganizePlanSheet, SortingPlanView } from "../components/OrganizePlanSheet";
import { OrganizeWalkSheet } from "../components/OrganizeWalkSheet";
import { LiveSortSheet } from "../components/LiveSortSheet";
import { } from "../components/ImageSearchPicker";
import { } from "../components/CropPhotoModal";
import { } from "../components/pastedImage";
import { ReceiptSourceViewer, type ReceiptMoney } from "../components/ReceiptSourceViewer";
import { ReceiptPeek } from "../components/ReceiptPeek";
import { DocumentSessionCard, SessionAddedByChip, SessionDocumentChip, sessionFileKey } from "../components/DocumentSessionCard";
import {
  addedByHow,
  addedByWords,
  documentKindWords,
  documentNeedsPerson,
  sessionAddedBy,
  sessionDocumentName,
  type AddedBy,
} from "@cobblr/platform-contract/scan-source";
import { documentChipLine, documentStateWords, readAgainWords } from "../lib/documentState";
import { inboxShown } from "../lib/inboxShown";
import { InboxDocuments } from "../components/InboxDocuments";
import { inboxSearchWords } from "@cobblr/platform-contract/scan-search";
import { } from "../lib/scanRerun";
import { } from "../lib/identifySentence";
import { } from "../lib/namelessCard";
import { receiptDateWords, type DateReading } from "../lib/receiptDateWords";
import { BinAdjustModal } from "../components/BinAdjustModal";
import { HeaderMenu, MenuHead, MenuItem, MenuNote, MenuSep } from "../components/HeaderMenu";
import { phoneFoldsSourceIcons } from "./sessionStripFold";
import { DuplicateRecordsSheet } from "./DuplicateRecordsSheet";
import { ReceiptAddressChip } from "../components/ReceiptAddressChip";
import { classifyOmni, omniPlaceholder } from "./omniIntake";
import { useInboxPaste } from "./inboxPaste";
import { ScanPendingPictures } from "./ScanPendingPictures";
import { ScanTwinsContext, twinsOf } from "./scanTwins";
import { usePendingPictures } from "../lib/pendingPictures";
import { } from "./scanNameEdit";
import { useAiStatus, useAiStatusAnswered, AiOffNotice, AiNoticeGiven, aiStatusLine } from "../components/AiStatusNotice";
import { putawayWalkChip, sessionAddCaption } from "@cobblr/platform-contract/scan-copy";
export { useAiStatus, AiOffNotice } from "../components/AiStatusNotice";
import { decideLocationScan, filingLabel } from "../lib/scanFiling";
import { useScanItemLink } from "./scanItemLink";
import { sessionPlaceItems } from "../lib/scanSessionPlace";
import type { SessionSays } from "../lib/sessionSays";
import { useHandheld } from "../lib/useHandheld";
import { } from "./ScanItemSheet";
import { ScanInboxMenu } from "./ScanInboxMenu";
import { } from "../lib/scanNotes";
import { } from "../components/ScanCardCommit";
import { } from "../components/ScanToolMenu";
import type { } from "@cobblr/platform-contract/scan-tools";
import { } from "../lib/splitOffer";
import { findCombineClusters } from "../lib/scanCombine";
import { incompleteSessions, sessionLines, sessionMergeOffer } from "../lib/scanSessionLines";
import { SCAN_UNDO_ACTIONS, scanDeletedRecovery } from "@cobblr/platform-contract/scan-recovery";
import {
  
  ApiError,
  api,
  
  type ScanInboxItem,
  type ScanCandidate,
  type ScanMenuEntry,
  type TrackedMatch,
} from "../lib/api";
import { classifyScanPayload } from "../lib/scanPayload";
import { filedIntoOf, scanRowState, scanSessionAction } from "@cobblr/platform-contract/scan-triage";
import { displayName } from "@cobblr/platform-contract/display-identity";
import { sessionVerdict, type SessionVerdict } from "@cobblr/platform-contract/scan-session";
import { itemEnriching } from "./scan-status";
import { attachBodyFor, confirmBodyFor, destinationCandidateOf, duplicateSummary, filedLine, isReadyToFile, placementPreview } from "./scanFileAll";
import { useScanViewer } from "./scanViewer";
import { resolveInstanceForFiling } from "./scanInstall";
import { arrivalLabel, arrivalOf } from "./scanArrival";
import type { ScanBatchMeta } from "../lib/api";
import { addSharedProducts, addedSharedMessage } from "../lib/sharedProducts";
import { parseSharedText } from "@cobblr/platform-contract/shared-text";
import { SeriesBanner } from "../components/ScanSeriesBanner";
import { installToastLine } from "../lib/installSummary";
import {
  sessionCategory,
  sessionFilingReadiness,
  sessionLocation,
  categoryAxisKey,
  categoryAxisFor,
  tableCategoryAxis,
} from "./sessionCategory";
import { usePublishChatContext } from "../lib/chat-context";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";
import { resolveSessionBatch, clearScanSession, readScanSession, isSessionFresh, SESSION_GAP_MS, gapSessionKey } from "../lib/scanSession";
import { tabBrowserId } from "../hooks/useBrowserDrive";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { } from "../lib/useFieldPresentation";
import { } from "../auth/AuthContext";
import { destinationLabel, type DestinationTable } from "@cobblr/platform-contract/destination-label";
import { KeepAsPurchase } from "./KeepAsPurchase";
import { InboxCard, GalleryTile } from "./ScanInboxCard";
import { FiledRowView, FiledSummaryView } from "./ScanFiledRow";
import { useFiledRows, withFiledRows } from "../lib/filedRows";
import { type ScanTarget } from "./scanInboxShared";
import { scanInboxKeys } from "../lib/scan-inbox-keys";
import { useUndoSplit } from "../lib/useUndoSplit";
import { countOf } from "@cobblr/platform-contract/plural";
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

/** The day alone, as a receipt's date reads, for the header line: the hour
 *  and "Yesterday" cost more width than a phone row has, and both are on the
 *  tooltip. */
function formatSessionDay(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "Earlier";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(slug!) });
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
    <div data-notice="scan-drive" className="inline-flex items-center gap-2 rounded-md border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-2.5 py-1 text-xs">
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

/** Where a committed scan went: the table the commit recorded (#3620),
 *  never a recomputation from its candidates and never a guess. Bananas
 *  filed into Groceries read "→ Inventory · Groceries?": the label came
 *  from the base kind the row kept, and a "better table" nudge was asked of
 *  a row already filed. A row filed before the record existed carries one
 *  from the backfill; until then its label is read from the base kind. */
function CommittedDestination({
  item,
  tables,
}: {
  item: { target_kind?: string | null; target_module?: string | null; barcode_text?: string | null; suggested_metadata?: unknown };
  tables: DestinationTable[];
}) {
  const filed = filedIntoOf(item.suggested_metadata);
  const label = filed?.label ?? destinationLabel(item.target_kind, tables, item.target_module);
  return (
    <div className="text-[10px] text-faint truncate" data-testid="committed-destination">
      {label ? `→ ${label}` : ""}
      {item.barcode_text ? ` · ${item.barcode_text}` : ""}
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
  const later = useLater();
  usePageTitle("Scan");
  const { activeSlug, activeOrg } = useActiveOrg();
  const scanOrigins = useScanOrigins(activeSlug);
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
  // ✨ Pick best button. The admin tier only, because turning it on commits
  // the workspace to a vision call per enriched scan. Off unless stored on.
  const canSetPhotoRank = roleSatisfies(activeOrg?.role, ["owner", "admin"]);
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
  const [readingPersonal, setReadingPersonal] = useState(false);
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
    onError: (e: unknown) => toast.error(`Couldn't change that setting: ${e instanceof ApiError ? e.message : String(e)}`),
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
  const aiAnswered = useAiStatusAnswered();
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
  // The review and waiting filters ask the SERVER for their rows, so an
  // item that needs review is in the filter whether or not its page was
  // scrolled into view (#3638).
  const [reviewOnly, setReviewOnly] = useState(false);
  const [staleOnly, setStaleOnly] = useState(false);
  const facet = staleOnly ? "waiting" : reviewOnly ? "needs_review" : null;
  const list = useInfiniteQuery({
    queryKey: scanInboxKeys.pending(activeSlug, batchId, facet),
    queryFn: ({ pageParam }) =>
      api.listScanInbox(activeSlug, {
        status: "pending",
        batch_id: batchId ?? undefined,
        limit: 50,
        cursor: pageParam,
        ...(facet ? { triage: facet } : {}),
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
  // The lines this page's parts came from (#6067), from every page loaded.
  const splitParents = useMemo(() => {
    const m: Record<string, SplitParent> = {};
    for (const p of list.data?.pages ?? []) Object.assign(m, p.split_parents ?? {});
    return m;
  }, [list.data]);
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
  // Every count this page shows, over EVERY pending row (inbox-counts.ts):
  // the header, the filters and their captions, never a loaded page's length.
  const countsQ = useQuery({
    queryKey: scanInboxKeys.stats(activeSlug, batchId),
    queryFn: () => api.getScanStats(activeSlug, batchId),
    enabled: !!activeSlug,
    refetchInterval: 8_000,
  });
  const counts = countsQ.data;
  const totalPending = counts?.pending ?? (facet ? 0 : (list.data?.pages[0]?.total ?? 0));
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
  // A session the page holds only part of is loaded whole, so its header,
  // File all and the ids that action takes are the session's (#3638). Only the
  // unfiltered list: a facet or a scope shows a chosen subset on purpose.
  const partialSessions = useMemo(() => (facet ? [] : incompleteSessions(items, batchMeta)), [facet, items, batchMeta]);
  useEffect(() => {
    if (partialSessions.length && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [partialSessions, hasNextPage, isFetchingNextPage, fetchNextPage]);
  // "Needs review" (a pending item that didn't cleanly resolve — no name yet, a
  // low-trust or rate-limited lookup, or low confidence) and the >2-day stale
  // nudge are defined ONCE, in @cobblr/platform-contract/scan-triage. The list
  // route filters by the same predicates (?triage=…) and Ask Cobb reads the
  // resulting flags off each row, so the count in this header and the answer the
  // assistant gives about the same queue cannot drift apart.
  const staleCount = counts?.waiting ?? 0;
  // A receipt session whose read failed needs a person as much as an item
  // with no name does: it counts here, so the header cannot say "2 to review"
  // over a failed receipt (#2892).
  const reviewCount = (counts?.needs_review ?? 0) + (counts?.failed_sessions ?? 0);
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
  const omniIntent = classifyOmni(searchQ, scanOrigins);
  // Only PLAIN WORDS filter - a half-typed barcode must not empty the list.
  const searchTokens = omniIntent.kind === "text" ? inboxSearchWords(omniIntent.value) : [];
  // A filed row stays where it was, saying where it went (lib/filedRows.ts):
  // until the next scan, leaving the inbox, or its ✕. Never on a timer.
  const filed = useFiledRows(activeSlug, items);
  const filedIds = useMemo(() => new Set(filed.rows.map((r) => r.item.id)), [filed.rows]);
  // Several filed rows are one line, shown where the latest of them was.
  const filedAnchor = filed.rows.at(-1)?.item.id ?? null;
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const undoFiling = async (id: string) => {
    setUndoingId(id);
    try {
      // The announcement from unconfirm takes the row out of the filed rows;
      // the refreshed list puts it back as a pending card, in the same place.
      await api.unconfirmScanItem(activeSlug, id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUndoingId(null);
    }
  };
  // The name of the file each document session was read from. A session that
  // has not been read has no other name: its title is the file's, never
  // "not read yet" (#4523). Asked of every session the page holds, not only
  // the ones on screen, because a search finds a failed read by its file.
  const sourceFileIds = useMemo(
    () =>
      [
        ...new Set(
          [...Object.values(batchMeta), ...Object.values(rowlessSessions)]
            .map((m) => m.source_file_id)
            .filter((id): id is string => !!id),
        ),
      ],
    [batchMeta, rowlessSessions],
  );
  const sourceFileQueries = useQueries({
    queries: sourceFileIds.map((id) => ({
      queryKey: sessionFileKey(activeSlug, id),
      queryFn: () => api.getFile(activeSlug, id),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const sourceFileNames = new Map<string, string>();
  sourceFileIds.forEach((id, i) => {
    const f = sourceFileQueries[i]?.data;
    if (f?.filename) sourceFileNames.set(id, f.filename);
  });
  // What the search leaves: rows AND the sessions with no rows (inboxShown).
  // The list, the gallery and every count below read this one answer.
  const shown = inboxShown(items, rowlessSessions, searchTokens, sourceFileNames);
  const visibleItems = shown.items;
  const shownSessions = shown.sessions;
  const visibleIds = useMemo(() => new Set(visibleItems.map((i) => i.id)), [visibleItems]);
  const twins = useMemo(() => twinsOf(visibleItems), [visibleItems]);
  const pendingPictures = usePendingPictures(activeSlug);
  // What the list DRAWS: the live rows, with each filed row back in its
  // place. Everything that counts, selects or acts reads visibleItems, so a
  // filed row is never counted, selected or filed again.
  const shownItems = useMemo(() => withFiledRows(visibleItems, filed.rows), [visibleItems, filed.rows]);
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
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      const qty = Number(fresh.quantity) || 1;
      toast.success(`Combined into one: ${displayName(fresh) ?? "item"}${qty > 1 ? ` ×${qty}` : ""}`);
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
          <div className="text-[10px] uppercase tracking-widest text-amber-700 dark:text-amber-500">
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
                Same barcode ({/* mono: a barcode's digits */}<span className="font-mono">{aiItem.barcode_text}</span>){" "}
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
              aria-label="Not the same - keep separate"
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
      // On a phone the words take the row and the two actions sit under
      // them: beside a 150px button the paragraph became a column a screen
      // tall (#3065). From sm up it is one row again.
      <div data-testid="combine-offer" className="rounded-lg border border-amber-300 dark:border-amber-700/60 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap">
        <Sparkles size={15} className="text-amber-500 shrink-0 max-sm:hidden" />
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1 text-sm">
          {/* One line, the fact and the names (#3884: the sentence explaining
              the combine was the longest thing on the card). What the tap
              does is on the button, beside it, and in full on hover. */}
          <span className="font-medium text-content dark:text-mortar-100">
            Same {isUnique ? clusterNoun : "product"} {cluster.items.length === 2 ? "twice" : `${countOf(cluster.items.length, "time")}`}
          </span>
          <span className="text-muted"> · {cluster.items.map((c) => displayName(c)).filter(Boolean).join(" · ")}</span>
        </div>
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            disabled={combineMut.isPending}
            onClick={() => combineMut.mutate({ ids, ...(isUnique ? {} : { keepId: keep.id }) })}
            title={`Combines these ${countOf(cluster.items.length, "pending row")} into one row in this inbox${isUnique ? " with all their details" : ` at ×${totalQty}`}. The other ${cluster.items.length > 2 ? "rows go" : "row goes"} to Recently deleted, where it can be restored. Nothing already filed changes.`}
            className="shrink-0 rounded bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50 min-h-9 sm:min-h-0"
          >
            {isUnique ? "Combine" : `Combine, ×${totalQty}`}
          </button>
          <span className="text-[11px] text-muted">the other{cluster.items.length > 2 ? "s go" : " goes"} to Recently deleted; nothing already filed changes</span>
        </span>
        <button
          type="button"
          title="Not the same - keep separate"
          onClick={() => setDismissedCombine((s) => new Set(s).add(sig))}
          className="shrink-0 inline-flex min-h-9 items-center gap-1 rounded px-2 text-sm text-faint hover:text-muted sm:min-h-0 sm:p-1"
        >
          <X size={16} /><span className="sm:hidden">Not the same</span>
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
      /** What the group draws: its items with any filed row in its place. */
      shown: ScanInboxItem[];
      latest: number; // max(created_at) — the session's real scan time
      lastTouched: number; // max(updated_at) — later edits (un-confirm, fixes)
      area: string | null;
      label: string | null; // session title (e.g. "Receipt · Home Depot")
      origin: string | null; // "email" → the header says "emailed <when>"
      originFrom: string | null; // who an emailed receipt came from
      vendor: string | null; // the shop the read found
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
    for (const it of shownItems) {
      // visibleItems arrive newest-first, so the "previous" item is newer.
      const t = Date.parse(it.created_at);
      let g: Group;
      if (it.scan_batch_id) {
        const existing = byBatch.get(it.scan_batch_id);
        if (existing) g = existing;
        else {
          const meta = batchMeta[it.scan_batch_id];
          g = { key: it.scan_batch_id, isBatch: true, batchId: it.scan_batch_id, items: [], shown: [], latest: 0, lastTouched: 0, area: null, label: meta?.label ?? null, origin: meta?.origin ?? null, originFrom: meta?.origin_from ?? null, vendor: meta?.vendor ?? null, sourceFileId: meta?.source_file_id ?? null, orderRef: meta?.order_ref ?? null, trackingNumber: meta?.tracking_number ?? null, shipmentState: meta?.shipment_state ?? null, shipmentDescription: meta?.shipment_description ?? null, shipmentLocation: meta?.shipment_location ?? null, verdict: { kind: "plain" }, dateReading: null };
          byBatch.set(it.scan_batch_id, g);
          groups.push(g);
        }
      } else {
        if (!pseudo || !Number.isFinite(t) || pseudoLastT - t > SESSION_GAP_MS) {
          pseudo = { key: `gap:${it.id}`, isBatch: false, batchId: null, items: [], shown: [], latest: 0, lastTouched: 0, area: null, label: null, origin: null, originFrom: null, vendor: null, sourceFileId: null, orderRef: null, trackingNumber: null, shipmentState: null, shipmentDescription: null, shipmentLocation: null, verdict: { kind: "plain" }, dateReading: null };
          groups.push(pseudo);
        }
        if (Number.isFinite(t)) pseudoLastT = t;
        g = pseudo;
      }
      g.shown.push(it);
      if (filedIds.has(it.id)) continue;
      g.items.push(it);
      if (Number.isFinite(t) && t > g.latest) g.latest = t;
      const u = Date.parse(it.updated_at);
      if (Number.isFinite(u) && u > g.lastTouched) g.lastTouched = u;
      if (!g.area && it.scan_area) g.area = it.scan_area;
    }
    // A gap session is keyed by its OLDEST item once the burst is known: keyed
    // by the newest, the key moved on every new scan and the whole group
    // remounted, dropping every card's pick (#3021, scanSession.ts).
    for (const g of groups) if (!g.isBatch) g.key = gapSessionKey(g.items.length ? g.items : g.shown);
    // The verdict, once the lines are counted; a session in the list whose
    // read failed or is in flight has no lines of its own and is its own group.
    for (const g of groups) {
      if (!g.batchId) continue;
      const meta = batchMeta[g.batchId];
      if (meta) {
        g.verdict = sessionVerdict(meta, sessionLines(g.items, meta));
        g.dateReading = { date_convention: meta.date_convention ?? null, date_decided_by: meta.date_decided_by ?? null, date_printed: meta.date_printed ?? null };
      }
    }
    for (const [id, meta] of Object.entries(shownSessions)) {
      if (byBatch.has(id)) continue;
      const v = sessionVerdict(meta, { pending: 0, ever: 0 });
      if (v.kind !== "failed" && v.kind !== "in_flight") continue;
      const t = meta.created_at ? Date.parse(meta.created_at) : 0;
      groups.push({ key: id, isBatch: true, batchId: id, items: [], shown: [], latest: Number.isFinite(t) ? t : 0, lastTouched: 0, area: null, label: meta.label ?? null, origin: meta.origin ?? null, originFrom: meta.origin_from ?? null, vendor: meta.vendor ?? null, sourceFileId: meta.source_file_id ?? null, orderRef: meta.order_ref ?? null, trackingNumber: meta.tracking_number ?? null, shipmentState: meta.shipment_state ?? null, shipmentDescription: meta.shipment_description ?? null, shipmentLocation: meta.shipment_location ?? null, verdict: v, dateReading: null });
    }
    return groups.sort((a, b) => b.latest - a.latest);
  }, [shownItems, filedIds, batchMeta, shownSessions]);
  // The documents the search left that have no rows to hang on (a read that
  // failed or is under way): the list draws them as sessions, the gallery as
  // a section of their own, and the caption counts them.
  const shownDocuments = sessionGroups.filter((g) => g.items.length === 0 && g.shown.length === 0);
  const documentCount = Object.values(rowlessSessions).filter((m) => {
    const v = sessionVerdict(m, { pending: 0, ever: 0 }).kind;
    return v === "failed" || v === "in_flight";
  }).length;

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
  // Where each session came from, said once (platform-contract scan-source,
  // #4581): its document by what it is, and who added it. The cards read the
  // same answer, so a card repeats it only when its own source differs.
  const sessionSourceOf = (g: (typeof sessionGroups)[number]) => {
    const addedBy = sessionAddedBy(g.items, { origin: g.origin, from: g.originFrom });
    const vendor = g.vendor ?? vendorOfItems(g.items);
    const docName = g.sourceFileId
      ? sessionDocumentName({ origin: g.origin, vendor, from: g.originFrom, date: documentDateOf(g.items) ?? (g.latest ? new Date(g.latest) : null), filename: sourceFileNames.get(g.sourceFileId) ?? null })
      : null;
    const kind = documentKindWords({ origin: g.origin, vendor, billOfSale: isBillOfSaleSession(g.items), source: receiptSourceOf(g.items) });
    return { addedBy, docName, chipWords: documentChipLine(kind, g.items), needsPerson: documentNeedsPerson(g.verdict, g.items) };
  };
  const sessionSourceByItem = new Map<string, { addedBy: AddedBy | null; emailed: boolean }>();
  const documentNames = new Map<string, string>();
  for (const g of sessionGroups) {
    const src = sessionSourceOf(g);
    for (const it of g.shown) sessionSourceByItem.set(it.id, { addedBy: src.addedBy, emailed: g.origin === "email" });
    if (g.sourceFileId && src.docName) documentNames.set(g.sourceFileId, src.docName);
  }
  const [addedByOpen, setAddedByOpen] = useState<string | null>(null);
  const menuAnchorRect = useRef<DOMRect | null>(null);
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(new Set());
  // Sessions whose "Do these belong together?" was pressed in the ⋯ (#3064).
  const [themeAsked, setThemeAsked] = useState<Set<string>>(new Set());
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
  // A link to ONE row (a search result, the dashboard's captured-item card):
  // on a desk, that card opens in place, scrolled to and outlined; on a phone,
  // its item screen. The link stays in the address (scanItemLink.ts, #3909).
  const itemLink = useScanItemLink(items, handheld);
  useEffect(() => {
    if (!itemLink.highlight) return;
    setHighlightId(itemLink.highlight);
    if (itemLink.openScreen) setGalleryFocusId(itemLink.openScreen);
  }, [itemLink]);
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
    queryKey: scanInboxKeys.discarded(activeSlug),
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
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const uncombine = useMutation({
    mutationFn: (id: string) => api.uncombineScanItem(activeSlug, id),
    onSuccess: (r) => {
      toast.success(`Combine undone: ${r.restored.length + 1} scans are back in the inbox as they were.`);
      setHighlightId(r.kept.id);
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Recently committed: a confirm is revertible too — "Send back" reopens the
  // scan as pending and removes the entity it CREATED (a scan that merely
  // attached to an existing entity leaves it untouched). The mirror of
  // Recently deleted, for the other resolution — a wrong commit is redoable,
  // not a dead end.
  const resolvedQ = useQuery({
    queryKey: scanInboxKeys.resolved(activeSlug),
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
  const committedGroups = useMemo(() => committedGroupsOf(recentlyCommitted), [recentlyCommitted]);
  const unconfirm = useMutation({
    mutationFn: (id: string) => api.unconfirmScanItem(activeSlug, id),
    onSuccess: (r) => {
      toast.success(
        r.entity_deleted
          ? "Sent back to the inbox. The created entry was removed."
          : `Sent back to the inbox.${r.note ? ` ${r.note}` : ""}`,
      );
      setHighlightId(r.item.id);
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // A split parent in this list did not create an entry; it made N inbox
  // items. Sending it back would leave them (the api refuses); undoing the
  // split is the revert that fits, and it is the one offered.
  const undoSplit = useUndoSplit({ onDone: (parent) => setHighlightId(parent.id) });
  const splitPieces = (it: ScanInboxItem): number =>
    ((it.suggested_metadata as { split_into?: unknown } | null)?.split_into as unknown[] | undefined)?.length ?? 0;
  // Revert a set of committed items. Returns who ACTUALLY went back and, for
  // each that did not, the reason in the server's words: a failure is never
  // anonymous (#4579), it is shown on the row it belongs to.
  const [revertFailures, setRevertFailures] = useState<Record<string, string>>({});
  const revertIds = async (ids: string[]): Promise<{ ok: number; failed: number; failures: Array<{ id: string; message: string }> }> => {
    const results = await Promise.allSettled(ids.map((id) => api.unconfirmScanItem(activeSlug, id)));
    const failures: Array<{ id: string; message: string }> = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") failures.push({ id: ids[i]!, message: r.reason instanceof ApiError ? r.reason.message : String(r.reason) });
    });
    await qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    return { ok: ids.length - failures.length, failed: failures.length, failures };
  };
  const reportRevert = ({ ok, failed, failures }: { ok: number; failed: number; failures: Array<{ id: string; message: string }> }) => {
    setRevertFailures((prev) => {
      const next = { ...prev };
      for (const f of failures) next[f.id] = f.message;
      return next;
    });
    if (failed) {
      toast.error(`${ok} sent back, ${failed} needs you`);
      const first = failures[0]?.id;
      if (first) requestAnimationFrame(() => document.getElementById(`committed-${first}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    } else if (ok) toast.success(`Sent ${ok} item${ok === 1 ? "" : "s"} back to the inbox.`);
  };
  // "Also undo the split?" per session, off by default: sending the filed
  // pieces back does not by itself bring the group photo back.
  const [alsoUndoSplit, setAlsoUndoSplit] = useState<Record<string, boolean>>({});
  // One filed row of Recently committed, with its own failure line when
  // sending it back was refused.
  const committedFailure = (id: string, groupKey: string) => (
    <div data-testid="send-back-failure" className="flex flex-wrap items-center gap-2 px-3 pb-1.5 pl-9 text-[11px] text-amber-700 dark:text-amber-300">
      <span className="min-w-0">Couldn't send back: {revertFailures[id]}</span>
      <button
        type="button"
        disabled={sendingBackAll === groupKey}
        onClick={() => {
          setRevertFailures((m) => {
            const { [id]: _drop, ...rest } = m;
            return rest;
          });
          unconfirm.mutate(id);
        }}
        className="underline"
      >
        Try again
      </button>
      <button
        type="button"
        onClick={() =>
          setRevertFailures((m) => {
            const { [id]: _drop, ...rest } = m;
            return rest;
          })
        }
        className="underline"
      >
        Keep
      </button>
    </div>
  );
  const committedFiledRow = (d: ScanInboxItem, groupKey: string, indent: string) => (
    <div key={d.id} id={`committed-${d.id}`}>
      <div className={`flex items-center gap-2 px-3 py-1.5 ${indent}`}>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-muted truncate">{displayName(d) ?? d.barcode_text ?? "Unknown scan"}</div>
          <CommittedDestination item={d} tables={destinationTables} />
        </div>
        <button
          type="button"
          onClick={() => unconfirm.mutate(d.id)}
          disabled={unconfirm.isPending || sendingBackAll === groupKey}
          className="shrink-0 text-xs text-faint hover:text-content disabled:opacity-50"
        >
          {SCAN_UNDO_ACTIONS.sendBack}
        </button>
      </div>
      {revertFailures[d.id] && committedFailure(d.id, groupKey)}
    </div>
  );
  // Send a whole session's committed items back to the inbox at once.
  const [sendingBackAll, setSendingBackAll] = useState<string | null>(null);
  const sendBackSession = async (key: string, batchId: string | null, visibleIds: string[], splitParents: ScanInboxItem[] = []) => {
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
          // A split parent is structure, not a filed item: it is never sent back.
          const fullIds = sendBackIdsOf(full.items ?? []);
          if (fullIds.length) ids = Array.from(new Set([...ids, ...fullIds]));
        } catch {
          /* quiet: fall back to the visible ids, which Send back names */
        }
      }
      const result = await revertIds(ids);
      if (alsoUndoSplit[key]) {
        for (const p of splitParents) {
          try {
            await api.unsplitScanItem(activeSlug, p.id);
          } catch (e) {
            result.failures.push({ id: p.id, message: e instanceof ApiError ? e.message : String(e) });
            result.failed++;
          }
        }
        await qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      }
      reportRevert(result);
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
      await qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
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
      const payload = classifyScanPayload(code, scanOrigins);
      if (payload.kind === "own-route") { navigate(payload.path); return; }
      if (payload.kind === "own-link" || payload.kind === "empty") return;
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
            /* quiet: contents unavailable, so the normal filing flow */
          }
          const items = locsQ.data?.items ?? [];
          const byId = new Map(
            items.map((l) => [
              l.id,
              { id: l.id, name: l.name, short_name: l.short_name, parent_id: l.parent_id, kind: l.kind },
            ]),
          );
          const decision = decideLocationScan(locId, fileBin || null, byId);
          // Nesting is the scanner's idea: when it cannot (a cycle, no
          // permission) filing goes on, and the toast says it did not nest.
          let nestFailed: string | null = null;
          if (decision.reparent) {
            try {
              await api.updateLocation(activeSlug, decision.reparent.child, editOf(byId.get(decision.reparent.child), {
                parent_id: decision.reparent.parent,
              }));
              await locsQ.refetch();
            } catch (e) {
              nestFailed = e instanceof Error ? e.message : "";
            }
          }
          setFileBin(decision.bin);
          const b = byId.get(decision.bin);
          const nm = b ? filingLabel(b) : "location";
          const p = decision.reparent ? byId.get(decision.reparent.parent) : null;
          if (p && nestFailed !== null) toast.error(`Could not put ${nm} in ${filingLabel(p)}${nestFailed ? `: ${nestFailed}` : ""}. Filing into ${nm}`);
          else toast.success(p ? `Filed ${nm} in ${filingLabel(p)}. Filing into ${nm}` : `Filing into ${nm}`);
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
  // Who is looking, for every readiness read on this page (the header's
  // count, the session strip, the sweep): the same context each card's row
  // reads, so a row a member cannot file is not counted by the strip beside
  // it (scanViewer.ts, #3122).
  const viewer = useScanViewer(menu);
  // A split part's table and values, as its card would file it (#6456): what
  // tells the split's group that its parts are alike.
  const splitRouteOf = useCallback(
    (it: ScanInboxItem) => {
      const c = destinationCandidateOf(it, viewer);
      return c ? { module: c.module, instance: c.instance ?? null, kind: c.kind ?? null, label: (c as { label?: string }).label ?? null, fields: c.fields ?? null } : null;
    },
    [viewer],
  );

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
    "inline-flex items-center justify-center rounded border border-line dark:border-slate-700 text-content hover:bg-subtle dark:hover:bg-slate-800/70 p-[6px] transition shrink-0";

  // ── the one intake box ────────────────────────────────────────────────────
  const [omniOpen, setOmniOpen] = useState(false);
  const omniRef = useRef<HTMLInputElement>(null);
  // A code or link that went in leaves the box empty: close it now, so the
  // next tap changes nothing under the finger. Left focused, the first tap
  // after it blurred the box, it collapsed mid-tap, and WebKit dropped that
  // tap's click: "+1 more" on the scan just added did nothing (#7836).
  const omniDone = () => {
    setSearchQ("");
    omniRef.current?.blur();
    setOmniOpen(false);
  };
  const submitOmni = async () => {
    const intent = classifyOmni(searchQ, scanOrigins);
    if (intent.kind === "own-route") {
      setSearchQ("");
      navigate(intent.value);
      return;
    }
    if (intent.kind === "cobblr-qr") {
      // A pasted Cobblr label: go where the QR goes, as the camera would.
      setSearchQ("");
      navigate(`/qr/${intent.value}`);
      return;
    }
    if (intent.kind === "upc") {
      wedgeScan.mutate(intent.value);
      omniDone();
      return;
    }
    if (intent.kind === "url" || intent.kind === "urls") {
      // Each link with the words it came with: a title pasted from a shopping
      // app is kept as the item's name (lib/sharedProducts.ts). A failure keeps
      // its reason; "Added 0" is never a success (reported 2026-08-12).
      const products = intent.products ?? intent.value.split("\n").map((url) => ({ title: null, url }));
      omniDone();
      const added = await addSharedProducts(activeSlug, products, { target_location_id: fileBin || undefined });
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      const said = addedSharedMessage(added);
      toast[said.tone](said.text);
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
    takeFiles(Array.from(e.dataTransfer.files ?? []), "drop");
  };
  // A picture pasted ANYWHERE on the inbox is intake, in the box or not
  // (#3852): the box is a collapsed icon on a phone and easy to miss on a
  // desk, and a paste that lands nowhere shows nothing, so it gets pasted
  // again. Through the one paste door (usePasteImage): the page is the area,
  // so a card's own photo (an area inside it) still takes a paste meant for
  // it, a dialog on top takes its own, and a text paste (a UPC, a link) still
  // lands in the field. A drop anywhere is intake too.
  const takeFilesRef = useRef(takeFiles);
  takeFilesRef.current = takeFiles;
  // Files first, then text (inboxPaste.ts): a picture or a PDF pasted
  // anywhere here, or into the box at the top, is taken as the upload button
  // takes it; text with no file is a product shared from a shopping app (the
  // iPhone path: Safari cannot make an installed web app a share target),
  // each link added with the words it came with as its name.
  useInboxPaste(
    (files) => takeFilesRef.current(files, "paste"),
    (text) => {
      const products = parseSharedText(text);
      if (!products.length || !activeSlug) return false;
      void addSharedProducts(activeSlug, products, { target_location_id: fileBin || undefined }).then((added) => {
        void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
        const said = addedSharedMessage(added);
        toast[said.tone](said.text);
      });
      return true;
    },
  );
  const [pageDrop, setPageDrop] = useState(false);
  useEffect(() => {
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setPageDrop(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setPageDrop(false);
    };
    const onDrop = (e: DragEvent) => {
      setPageDrop(false);
      if (!carriesFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      takeFilesRef.current(Array.from(e.dataTransfer?.files ?? []), "drop");
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

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
  const confidentCount = counts?.ready_to_file ?? 0;
  // On a phone the header row has ~163px for its counts. Measured at 393px
  // (#3497): an August-sized backlog ("81 · 46 ready · 4 to review") already
  // pushed "to review" off the row's edge, and adding the total's word cut it
  // by 56px. So on a phone the row carries only the facets a person acts on,
  // "to review" first, and the total moves to the ... menu. The total stays on
  // the row, with its word, when it is the only count there is.
  const showReadyFacet = confidentCount > 0 && confidentCount < totalPending;
  const rowCarriesFacet = showReadyFacet || reviewCount > 0;

  // The standing bin, resolved to a location so the chip can NAME it.
  const fileBinName = fileBin ? (locsQ.data?.items ?? []).find((l) => l.id === fileBin) : null;
  // Items sitting here with no location of their own. The standing bin only
  // stamps target_location_id at SCAN time, so anything scanned before it was
  // set is still loose - this is the count the menu offers to fix.
  const looseIds = counts?.loose_ids ?? [];
  const looseCount = looseIds.length;

  // Bulk triage: select N items, then confirm / discard the whole selection at
  // once (each confirm routes to its own matchmaker top candidate, fields and
  // all). Loops the existing per-item endpoints — no server change.
  const [selected, setSelected, clearTicks] = useTickedRows(list.data ? items.map((i) => i.id) : null);
  // What is ticked is what Cobb is talking about: "file these in Mugs" means
  // exactly these, and Cobb reads each by its id (list_scan_inbox, the item's
  // own read), never asks "which ones?".
  // With nothing ticked, a list narrowed to one session, a search or a filter
  // is what "these" means: the rows it shows go to Cobb.
  const narrowed = !!batchId || searchTokens.length > 0 || !!facet;
  useAskCobbAboutSelection(
    selected,
    items.map((i) => ({ id: i.id, name: i.suggested_name })),
    "core-scan:item",
    "inbox item",
    narrowed ? visibleItems.map((i) => ({ id: i.id, name: i.suggested_name })) : null,
  );
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
    queryKey: scanInboxKeys.stats(activeSlug),
    queryFn: () => api.getScanStats(activeSlug),
    enabled: !!activeSlug,
    staleTime: 15_000,
  });
  // Warm the pending plan when unfiled items exist (debounced 5s so an active
  // scanning burst settles) — "Put them away" should reveal a ready plan, not
  // start one. Server-side fingerprint dedupe makes repeats free.
  const unfiledCount = scanStatsQ.data?.unfiled ?? 0;
  // The list, its counts and the put-away strip above it are drawn together,
  // once all of them have answered: the strip arriving after the rows pushed
  // each row's buttons down, the loading line leaving moved the strip's
  // button up, and the tables' menu arriving gave every session its place,
  // its Add and its caption at once, and the locations a place chip needs
  // arrived after the rows (#7789).
  // Waited for once: a count asked again under a new key (a facet, a batch)
  // must not take the drawn rows back to "loading…".
  const answeredOnce = useRef(false);
  if (!countsQ.isLoading && !scanStatsQ.isLoading && !menuQ.isLoading && !modulesQ.isLoading && !locsQ.isLoading && aiAnswered) answeredOnce.current = true;
  const inboxSettled = !list.isLoading && answeredOnce.current;
  // What sits under the list waits, on the first load, for the rows above it
  // to finish routing: a pack folding into short rows once routed took 816 px
  // out from over Recently committed (#7789). Once, so a scanning burst later
  // never hides it.
  const quietOnce = useRef(false);
  if (inboxSettled && !(list.data?.pages ?? []).some((p) => (p.items ?? []).some((it) => itemEnriching(it)))) quietOnce.current = true;
  const listQuiet = inboxSettled && quietOnce.current;
  const readyCount = scanStatsQ.data?.ready ?? 0;
  useEffect(() => {
    if (!activeSlug || (unfiledCount === 0 && readyCount === 0)) return;
    const t = setTimeout(() => {
      void api.warmOrganizePlan(activeSlug).catch(() => {});
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
    return { planId: q.plan_id, remaining: q.remaining, places: q.groups, resumed: !!q.session_id };
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
                sessionSource={sessionSourceByItem.get(it.id) ?? null}
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
    let lastFailure: string | null = null;
    for (const id of ids) {
      try {
        await api.updateScanItem(activeSlug, id, { target_location_id: locId });
        ok++;
      } catch (e) {
        // Keep going with the rest; the summary says how many did not move.
        lastFailure = e instanceof Error ? e.message : "";
      }
    }
    setBulkBusy(false);
    if (!explicitIds) clearSelected();
    void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    const name = (locsQ.data?.items ?? []).find((l) => l.id === locId);
    toast.success(`Filed ${ok} item${ok === 1 ? "" : "s"} into ${name ? filingLabel(name) : "the location"}.`);
    if (ok < ids.length) toast.error(`${ids.length - ok} item${ids.length - ok === 1 ? "" : "s"} did not move${lastFailure ? `: ${lastFailure}` : ""}.`);
  };
  const bulkDiscard = async () => {
    setBulkBusy(true);
    const done: string[] = [];
    let lastFailure: string | null = null;
    for (const id of selected) {
      try {
        await api.discardScanItem(activeSlug, id);
        done.push(id);
      } catch (e) {
        // Keep going; the summary says how many stayed.
        lastFailure = e instanceof Error ? e.message : "";
      }
    }
    if (done.length < selected.size) toast.error(`${selected.size - done.length} item${selected.size - done.length === 1 ? "" : "s"} could not be removed${lastFailure ? `: ${lastFailure}` : ""}.`);
    setBulkBusy(false);
    const tickAgain = clearTicks();
    void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    // Undo inline — restores the whole batch if it was a mis-tap.
    toast.action(`Removed ${done.length} item${done.length === 1 ? "" : "s"}.`, {
      actionLabel: "Undo",
      duration: 7000,
      onAction: async () => {
        await Promise.allSettled(done.map((id) => api.restoreScanItem(activeSlug, id)));
        void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
        tickAgain();
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
    mutationFn: (v: { from: string; into: string; intoName: string; itemIds: string[] }) =>
      api.mergeScanBatches(activeSlug, v.from, v.into),
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast.action(`Merged ${r.moved} item${r.moved === 1 ? "" : "s"} into ${v.intoName}.`, {
        actionLabel: "Undo",
        onAction: async () => {
          try {
            await api.reassignScanBatch(activeSlug, v.itemIds, v.from);
            await qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
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
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast.success(readAgainWords(r));
    },
    onError: (e) => {
      // Failed again: the session's state carries the new reason; refetch so
      // the row says it rather than keeping the old sentence.
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
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
  const trackingPanelRef = useRef<HTMLDivElement>(null);
  // The parcel panel is a layer: Escape closes it only when nothing is over it.
  // Escape must not dump keyboard users at the document root - hand focus
  // back to the trigger, the way the destination menu does.
  useEscapeToClose(!!trackingPopover, trackingPanelRef, () => {
    trackingPopRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    setTrackingPopover(null);
  });
  useEffect(() => {
    if (!editingPo && !editingTracking && !trackingPopover) return;
    const closeAll = () => {
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
    // escape-not-a-layer: cancels an inline PO / tracking edit in the row; the parcel panel closes through useEscapeToClose above.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setEditingPo(null);
      setEditingTracking(null);
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
  useCloseOnPageScroll(!!trackingPopover, () => setTrackingPopover(null));
  const setOrderRef = useMutation({
    mutationFn: (v: { batchId: string; orderRef: string | null }) =>
      api.setReceiptOrderRef(activeSlug, v.batchId, v.orderRef),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      setEditingPo(null);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const setTracking = useMutation({
    mutationFn: (v: { batchId: string; tracking: string | null }) =>
      api.setReceiptTracking(activeSlug, v.batchId, v.tracking),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
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
    void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    toast.success(`Added ${ok} to ${entry.label}${skipped ? `, ${skipped} skipped (no name / failed)` : ""}`);
  };
  // Commit each item to its OWN top candidate — the destination the matchmaker
  // already picked ("as-is" routing). Shared by the selection bulk-confirm and
  // the per-session "File all" button. A pending item without a confident
  // candidate or a name stays pending for a manual look and is reported;
  // already-resolved items in the set are skipped silently.
  const confirmItemsToTheirCandidate = async (
    ids: Iterable<string>,
    agreedCategory?: string | null,
    agreedLocationId?: string | null,
  ) => {
    const byId = new Map(items.map((i) => [i.id, i]));

    // NO QUESTION BEFORE FILING. Every row files to the destination its card
    // shows (confirmBodyFor reads destinationCandidateOf, #3618), so a "may
    // belong somewhere else" modal could only propose the table the row
    // already had: File 1 on a settled Spices item asked "1 -> Spices" (#4584).
    // A person's disagreement is theirs to make on the card, where the better
    // table is a chip; filing says where it went and offers the way back.
    const idList = [...ids];

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
      // The table each row goes to is the card's (#3618), not the raw route.
      const row = byId.get(id);
      const cand = (row ? destinationCandidateOf(row, viewer) : undefined) as
        | { bundle_external_id?: string; label?: string }
        | undefined;
      if (cand?.bundle_external_id) needed.set(cand.bundle_external_id, cand.label ?? "a table");
    }
    const installed = new Map<string, { instance: string | null }>();
    for (const bundleId of needed.keys()) {
      const fallback = [...ids]
        .map((id) => {
          const row = byId.get(id);
          return row ? destinationCandidateOf(row, viewer) : undefined;
        })
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
    /** What filed, and where, for the done-toast and its Undo. */
    const filed: Array<{ id: string; label: string; locationId: string | null }> = [];
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
      const attach = it ? attachBodyFor(it, viewer) : null;
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
          // quiet: filing it as new is what would have happened anyway.
          console.warn("[scan] merge into existing failed, filing as new:", e);
        }
      }
      if (mergedThis) continue;
      const bundleId = ((it ? destinationCandidateOf(it, viewer) : undefined) as { bundle_external_id?: string } | undefined)
        ?.bundle_external_id;
      const body = it
        ? confirmBodyFor(
            it,
            agreedCategory,
            agreedLocationId,
            (bundleId && installed.get(bundleId)) || null,
            // The DECLARED category axis, so the agreed category applies even
            // when the stored value spells it differently than the candidate,
            // and reaches a table that keeps its own categories by name.
            categoryAxisFor(it, menu),
            viewer,
          )
        : null;
      if (!body) {
        if (it && it.status === "pending") skipped++;
        continue;
      }
      try {
        await api.confirmScanItem(activeSlug, id, body);
        ok++;
        filed.push({ id, label: scanRowState(it!, viewer).destination?.label ?? "Inventory", locationId: body.location_id ?? null });
      } catch (e) {
        failed++;
        // The endpoint's message is actionable ("Enable Inventory in
        // Configuration") - throwing it away turned every total failure into
        // an unexplained green "0 confirmed · N failed" (2026-08-25 audit).
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    setBulkProgress(null);
    void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    const places = new Set(filed.map((f) => f.locationId));
    const place = places.size === 1 ? (locsQ.data?.items ?? []).find((l) => l.id === [...places][0]) : undefined;
    const parts = [ok ? filedLine(filed, place ? filingLabel(place) : null) : "0 filed"];
    if (merged) parts.push(`${merged} added to what you already had`);
    if (skipped) parts.push(`${skipped} need a manual look`);
    if (failed) parts.push(`${failed} failed${lastErr ? ` - ${lastErr}` : ""}`);
    if (ok === 0 && failed > 0) toast.error(parts.join(" · "));
    else if (failed > 0) toast.info(parts.join(" · "));
    else if (ok > 0) {
      // A done thing is a toast, and the way back rides on it.
      const filedIds = filed.map((f) => f.id);
      toast.action(parts.join(" · "), { actionLabel: "Undo", duration: 10000, onAction: () => void revertIds(filedIds).then(reportRevert) });
    } else toast.success(parts.join(" · "));
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
    void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
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
    <ScanTwinsContext.Provider value={twins}>
    <div data-scan-inbox className="space-y-3 max-w-4xl mx-auto">
      {/* Nothing but the counts and the actions sits above the first row (the
          owner, 2026-10-12: a "Personal documents" box sat here on every
          visit). Its reader is "Read a personal document" in the ⋯ menu, and
          the inbox's doors take a personal document there by themselves.
          Guarded by e2e/walks/the-scan-inbox-starts-with-its-rows.json. */}
      <ReadPersonalDocumentModal open={readingPersonal} onClose={() => setReadingPersonal(false)} />
      {/* A session opened from an order line ("Scan the items", #5734). */}
      {batchId && <ScanningInBanner batchId={batchId} />}
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
      <div
        data-inbox-header
        data-toolbar="row"
        className={
          "relative flex items-center gap-[8px] max-sm:gap-[6px] max-sm:justify-between flex-nowrap border-b border-line dark:border-slate-700 pb-2.5 " +
          // A phone's open search is a line of its own under the row (see the
          // box below), the one time this row has two lines.
          (omniOpen ? "max-sm:flex-wrap max-sm:gap-y-2" : "")
        }
      >
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
        {/* The counts change as rows are read, so they hold the row's slack
            and nothing beside them moves when one arrives (#7789): on a phone
            the group takes the spare width and the controls pack right; on a
            desk the elastic search box comes straight after it. */}
        <div className="flex items-center gap-2 shrink min-w-0 max-sm:flex-1 sm:order-[-2]">
        <h1 className="sr-only sm:not-sr-only text-lg font-semibold text-content dark:text-mortar-100 shrink-0">
          Inbox
        </h1>
        {/* The counts keep their words' width and the row scrolls: the touch
            rule's min-width replaces a flex item's own (its text), so a
            count could shrink under its words and "1 ready" drew over
            "1 to review" at 320 (#7100). */}
        <div data-inbox-facets className="flex items-baseline gap-0 max-sm:gap-2 shrink min-w-0 leading-none overflow-x-auto [&>*]:shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden whitespace-nowrap text-[13px] text-muted dark:text-slate-400">
          {/* The total. On a tablet the word is a luxury the counts paid ~55px
              for, so it shows only on a desktop or on an empty inbox (a lone
              "0" is a riddle). On a phone it leaves the row whenever a facet
              is there (see rowCarriesFacet) and says its word when it stays:
              "1  1 to review" read as two numbers side by side (#3497). */}
          <span className={rowCarriesFacet ? "max-sm:hidden" : ""}>
            <span className="text-sm font-semibold text-content dark:text-mortar-100">{totalPending}</span>
            <span className={totalPending === 0 ? "" : "sm:hidden lg:inline"}>&nbsp;pending</span>
          </span>
          {showReadyFacet && (
            <>
              <span className="hidden sm:inline px-1 text-faint">·</span>
              <button
                type="button"
                onClick={() => {
                  setReviewOnly(false);
                  setStaleOnly(false);
                }}
                title="A confident name and destination, nothing flagged - these are what File all commits"
className="rounded px-1 py-0.5 text-[12.5px] hover:bg-subtle dark:hover:bg-slate-800 transition"
              >
                <b className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {confidentCount}
                </b>
                {/* The word at every width. Under lg these facets dropped
                    their words for a bare glyph, and on a phone that drew as a
                    4px wedge a stranger at a stand had to decode (#3321): a
                    count followed by a symbol says nothing; "1 to review"
                    costs about 60px the row can spend, since it scrolls. */}
                <span>&nbsp;ready</span>
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
                  "max-sm:-order-1 rounded px-1 py-0.5 text-[12.5px] transition " +
                  (reviewOnly
                    ? "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200"
                    : "hover:bg-subtle dark:hover:bg-slate-800")
                }
              >
                <b className="font-semibold text-amber-600 dark:text-amber-400">{reviewCount}</b>
                <span>&nbsp;to review</span>
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
            row, where it was the first thing to fall off. Its words come
            from the rows, so it waits for them rather than growing after it
            is shown; the elastic member beside it gives way (#7789). */}
        {batchId && inboxSettled && (
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
         
          onClick={() => {
            if (!omniOpen) {
              setOmniOpen(true);
              later.after("omni-focus", 0, () => omniRef.current?.focus());
            }
          }}
          className={
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition min-w-0 " +
            (dropHot
              ? "border-accent border-dashed bg-cobble-50/60 dark:bg-cobble-900/25 "
              : "border-dashed border-line dark:border-slate-700 ") +
            // Wide: always open and elastic, sharing the row. Tight: open, it
            // takes a line of its own UNDER the row, full width. Sharing the
            // row on a phone left the field a stub and the placeholder cut
            // mid-word (reported 2026-08-10); covering the row instead hid the
            // counts and Set location for as long as a search was typed in, so
            // you could not see or change where the next scan files while
            // looking for something (#3996's sibling). Same control, two shapes.
            (omniOpen
              ? "flex-1 min-w-[9rem] sm:order-[-1] max-sm:order-last max-sm:basis-full"
              : "flex-1 min-w-[9rem] sm:order-[-1] hidden sm:flex") +
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
          {/* search-input-ok: the inbox omnibox also ADDS (a pasted UPC or link), with an intent icon and an action button; it carries its own × and Esc clears it */}
          <input
            ref={omniRef}
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
           
            onBlur={() => {
              // Collapsing while it holds text would eat the search you are
              // in the middle of typing. An empty one closes once the tap that
              // blurred it is over: closing during it moved the page under the
              // finger, and WebKit dropped the tap's click (#7836).
              later.after("omni-collapse", 400, () => {
                if (document.activeElement !== omniRef.current && !omniRef.current?.value.trim()) setOmniOpen(false);
              });
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
              title="Clear search"
              type="button"
              onClick={(e) => {
                e.preventDefault();
                setSearchQ("");
                omniRef.current?.focus();
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
              title="Close search"
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
            title="Search the inbox"
            type="button"
            onClick={() => {
              setOmniOpen(true);
              later.after("omni-focus", 0, () => omniRef.current?.focus());
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
          accept={SCAN_PICKER_ACCEPT}
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
          <ReceiptAddressChip address={receiptAddress} name={receiptAddrQ.data?.receipt_name ?? undefined} className="hidden sm:inline-flex" />
        )}

        {/* Everything that is real but rare: ScanInboxMenu.tsx. */}
        <ScanInboxMenu
          handheld={handheld}
          triggerClassName={headerIcon}
          gallery={{ on: galleryView, toggle: toggleGalleryView }}
          pending={{
            total: totalPending,
            onRow: !rowCarriesFacet,
            filtered: reviewOnly || staleOnly,
            showAll: () => {
              setReviewOnly(false);
              setStaleOnly(false);
            },
          }}
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
          onReadPersonalDocument={() => setReadingPersonal(true)}
          onExport={() => setExportOpen(true)}
          onImport={() => setImportOpen(true)}
          receiptAddress={receiptAddress}
          receiptName={receiptAddrQ.data?.receipt_name ?? undefined}
          onOrganizeUnplaced={() => setOrganizeUnplacedOpen(true)}
          scanDrive={scanDrive}
          photoRank={{ can: canSetPhotoRank, data: photoRank.data, pending: setPhotoRank.isPending, set: (v) => setPhotoRank.mutate(v) }}
          glance={{ data: glanceCfg.data, pending: setGlanceCfg.isPending, set: (v) => setGlanceCfg.mutate(v) }}
          onFileEverything={() => setFileEverything({ batchId: null, defaultLocationId: fileBin || null, scope: "the inbox" })}
          onDuplicates={() => setShowDuplicates(true)}
        />
      </div>

      {/* On a phone these two are in the page menu (ScanInboxMenu), so the
          first card stays inside the first 320px (#7766). Above the notices,
          which arrive with the list (#7789). */}
      <div data-inbox-actions className="flex flex-wrap gap-x-4 gap-y-1 max-sm:hidden">
        <Link className="inline-block text-sm text-accent underline" to="/scan/stations">Scan stations</Link>
        {/* A tablet and a scanner as a station of its own (#4640). */}
        <Link className="inline-block text-sm text-accent underline" to="/configuration/devices?tab=stations">Open a station on a tablet</Link>
      </div>

      {inboxSettled && <AiOffNotice status={aiStatus} needs="identify" />}

      <ScanDrivePanel drive={scanDrive} />

      {/* When you arrived here from an instance's table ("Scan" on the Yarn
          page), confirms default into that instance. */}
      {target && (
        <div data-notice="scanning-into" className="rounded-md border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2 text-sm text-content dark:text-mortar-100 flex items-center gap-2">
          <ScanLine size={15} className="text-accent shrink-0" />
          Scanning into <strong>{target.label}</strong>  - each confirm adds it to that table.
        </div>
      )}

      {!inboxSettled && <div className="text-sm text-faint">loading…</div>}
      {/* An error is NOT an empty inbox. Rendering the friendly empty state on
          a failed fetch told a user with 80 pending scans that they had none,
          and they re-scanned things they already had (2026-08-25 audit). */}
      {list.isError && !list.isLoading && (
        <div data-notice="inbox-error" className="rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-6 text-center">
          <div className="text-sm text-red-800 dark:text-red-300">
            {/* failure-copy: list.isError, the inbox request itself failed. */}
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
      {pageDrop && (
        <OverlayLayer className="pointer-events-none flex items-center justify-center bg-cobble-50/70 dark:bg-slate-900/70 border-4 border-dashed border-accent" data-testid="page-drop-zone">
          <span className="rounded-lg bg-surface dark:bg-slate-800 px-4 py-2 text-sm font-medium text-content dark:text-mortar-100 shadow">Drop to add to the inbox</span>
        </OverlayLayer>
      )}
      <ScanPendingPictures slug={activeSlug} rowIds={visibleIds} />
      {inboxSettled && !list.isError && searchTokens.length === 0 && shownItems.length === 0 && Object.keys(rowlessSessions).length === 0 && pendingPictures.length === 0 && (
        <ScanInboxEmptyState pendingCount={totalPending} onReceipt={() => receiptRef.current?.click()} />
      )}



      {/* The put-away front door on the page itself: a captured backlog is
          Guided Organize's native situation — ONE verb, preview-first
          (put-away.md §5). Live Sort lives where scanning starts instead. */}
      {inboxSettled && viewMode !== "plan" &&
        ((scanStatsQ.data?.unfiled ?? 0) > 0 || (scanStatsQ.data?.ready ?? 0) > 0) && (
        // ONE line at every width: the count truncates before the button
        // moves. On a phone it was three lines and a large button, 82px
        // before the list had said anything (the owner, #2982).
        <div
          className="flex flex-row items-center gap-2 sm:gap-3 max-sm:text-[13px] max-sm:py-1.5 rounded-lg border border-cobble-400 dark:border-cobble-600 border-l-4 border-l-cobble-500 dark:border-l-cobble-400 bg-cobble-100 dark:bg-cobble-900 shadow-sm px-3 py-2.5 text-sm"
          data-testid="putaway-strip"
          data-inbox-counts
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
          ▶ {putawayWalkChip(resumableWalk.remaining, resumableWalk.places, resumableWalk.resumed)}
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
            className="rounded border border-line dark:border-slate-600 p-1 text-danger hover:bg-subtle dark:hover:bg-slate-700 transition disabled:opacity-50"
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
              <div className="text-[10px] uppercase tracking-widest text-faint mb-1.5">
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
        <AiNoticeGiven when={!!aiStatusLine(aiStatus, "identify")}>
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
            void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
            void qc.invalidateQueries({ queryKey: ["organize-plan-latest", activeSlug] });
          }}
          onStartWalk={(planId) => void startWalk(planId)}
          renderItemCard={renderPlanItemCard}
        />
        </AiNoticeGiven>
      )}

      {/* The pending-backlog plan is now the inline "Sorting plan" lens (see the
          header toggle + the list block above), not a modal. */}

      {organizeUnplacedOpen && (
        <AiNoticeGiven when={!!aiStatusLine(aiStatus, "identify")}>
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
        </AiNoticeGiven>
      )}

      {intake.sheet}
      {fileEverything && (
        <FileEverythingSheet
          slug={activeSlug}
          batchId={fileEverything.batchId}
          defaultLocationId={fileEverything.defaultLocationId}
          scope={fileEverything.scope}
          onClose={() => setFileEverything(null)}
          onFiled={() => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) })}
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
            void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
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
        <ActiveScanSessionNotice
          settled={inboxSettled}
          session={activeSession!}
          onEnd={() => {
            clearScanSession(activeSlug);
            toast.success("Session ended - the next scan starts a new one");
          }}
        />
      )}

      {/* ── the LIST's own bar ───────────────────────────────────────────────
          How the list is grouped and how dense it is are properties OF THE
          LIST, so they sit with it rather than in the page header. That also
          takes four controls out of a row that had eighteen. */}
      {inboxSettled && items.length > 0 && (
        <div data-inbox-actions className="flex items-center gap-2 text-xs -mb-1">
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
          {/* A filter's count is the server's, over every pending item; a
              text search narrows only what is loaded, and says so. */}
          {facet ? (
            <span className="text-faint dark:text-slate-500" data-testid="filter-caption">
              {facet === "waiting" ? staleCount : reviewCount} of {totalPending} shown
            </span>
          ) : searchTokens.length > 0 && (visibleItems.length !== items.length || shownDocuments.length !== documentCount) ? (
            <span className="text-faint dark:text-slate-500" data-testid="filter-caption">
              {visibleItems.length} of the {items.length} loaded match
              {shownDocuments.length > 0 ? `, and ${shownDocuments.length === 1 ? "1 document" : `${shownDocuments.length} documents`}` : ""}
            </span>
          ) : null}
          {/* Filtered to NOTHING: without this the list under "0 of 81 shown"
              was a blank void, and the tiny counter is easy to miss. One click
              back to everything. */}
          {(items.length > 0 || documentCount > 0) && visibleItems.length === 0 && shownDocuments.length === 0 && (
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

      {inboxSettled && (
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
          <AiNoticeGiven when={!!aiStatusLine(aiStatus, "identify")}>
          <SortingPlanView
            slug={activeSlug}
            scope="pending"
            itemIds={[]}
            itemsById={new Map(items.map((i) => [i.id, i]))}
            onApplied={() => {
              void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
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
          </AiNoticeGiven>
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
              {/* mono: the code being looked up */}
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
          const card = (item: ScanInboxItem, says?: SessionSays) => {
            if (filedIds.has(item.id)) {
              if (filed.rows.length > 1) {
                return item.id === filedAnchor ? (
                  <FiledSummaryView key="filed-summary" slug={activeSlug} rows={filed.rows} onDismiss={filed.dismiss} />
                ) : null;
              }
              const row = filed.rows[0]!;
              return (
                <FiledRowView
                  key={item.id}
                  slug={activeSlug}
                  row={row}
                  onUndo={() => void undoFiling(item.id)}
                  undoing={undoingId === item.id}
                  onDismiss={filed.dismiss}
                />
              );
            }
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
                sessionSource={sessionSourceByItem.get(item.id) ?? null}
                  sessionSays={says ?? null}
                  hasLocations={hasLocations}
                  selected={selected.has(item.id)}
                  onToggleSelect={() => toggleSelected(item.id)}
                  onArmBin={setFileBin}
                  onOpenSheet={(cand) => openSheet(item.id, cand)}
                  selectionActive={selected.size > 0}
                  openSignal={itemLink.openInPlace?.id === item.id ? itemLink.openInPlace.signal : 0}
                />
              </div>
            );
          };
          // Gallery view: a flat photo-tile grid for visual triage; a tap opens
          // the full card pre-expanded in a modal.
          // The documents with no rows (a failed or running read) stand above
          // the tiles with their Read again, as the list keeps them (#6034).
          if (galleryView) {
            return (
              <>
                <InboxDocuments
                  slug={activeSlug}
                  documents={shownDocuments.map((g) => ({
                    key: g.key,
                    batchId: g.batchId!,
                    fileId: g.sourceFileId,
                    name: sessionSourceOf(g).docName ?? g.label ?? "Document",
                    state: documentStateWords(g.verdict, g.items),
                    verdict: g.verdict,
                  }))}
                  readingBatch={reparse.isPending ? reparseBatch : null}
                  onReadAgain={(id) => reparse.mutate(id)}
                  onOpen={setViewSource}
                />
                <div className={TILE_GRID}>
                  {visibleItems.map((it) => (
                    <GalleryTile key={it.id} item={it} slug={activeSlug} onOpen={() => setGalleryFocusId(it.id)} />
                  ))}
                </div>
              </>
            );
          }
          // Flat list when there's nothing to group by (scoped ?batch view).
          if (!showSessionHeaders) return shownItems.map((it) => card(it));
          // Otherwise a collapsible header per group: a real session shows its
          // time (· area); a day bucket shows the day. Both show a count.
          return sessionGroups.map((g, gi) => {
            // A session whose every row was just filed has nothing left to
            // act on: its filed rows stand without a header offering File.
            if (g.items.length === 0 && g.shown.length > 0) {
              return (
                <div key={g.key} className="space-y-2">
                  {g.shown.map((it) => card(it))}
                </div>
              );
            }
            const collapsed = collapsedSessions.has(g.key);
            const groupIds = g.items.map((i) => i.id);
            const allGroupSelected = groupIds.length > 0 && groupIds.every((gid) => selected.has(gid));
            // Merge target: the NEXT (older) group that is a real batch.
            // The label and the action from one resolution (#3711).
            const mergeOffer = sessionMergeOffer(sessionGroups, gi, (t) => sessionName(t, t.isBatch && !!t.label?.startsWith("Receipt")) ?? formatSessionTime(t.latest));
            const mergeInto = mergeOffer?.into ?? null;
            // "Do these belong together?" is offered for a scan session of two
            // or more pending rows (a receipt is already one group). It
            // SURFACES on its own only on evidence: the rows already agree on a
            // category that some of them still lack, so the tag-and-category
            // pass has something to apply (#3064; the owner: keep the
            // capability, drop the standing prompt).
            const pendingRows = g.items.filter((i) => i.status === "pending");
            const themeOffer = !!g.batchId && pendingRows.length >= 2 && !g.items.every((i) => i.source_kind === "receipt");
            const themeEvidence = (() => {
              if (!themeOffer) return false;
              const agreed = sessionCategory(pendingRows);
              return !!agreed.suggestion && !agreed.unanimous && agreed.seen.length >= 1;
            })();
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
            const sessionAction = scanSessionAction(g.items, viewer);
            const readyIds = sessionAction.ids;
            // Still being routed, with nothing ready: what the row will offer
            // is not known yet, so the header holds only its name and "N
            // finishing…", and its controls arrive together with File.
            // Drawing some of them first moved them under a finger when File
            // came in beside them (#7789).
            const routing = busy > 0 && readyIds.length === 0;
            // Tables these items are routed to that the workspace does not have
            // yet. Filing installs them (see confirmItemsToTheirCandidate); the
            // tooltip says so, because installing a table is not something to
            // discover after the fact.
            const willInstallLabels = [
              ...new Set(
                g.items
                  .filter((it) => isReadyToFile(it, viewer))
                  .map((it) => destinationCandidateOf(it, viewer) as { bundle_external_id?: string; label?: string } | null)
                  .filter((c) => c?.bundle_external_id)
                  .map((c) => c!.label ?? "a table"),
              ),
            ];
                const readyItems = g.items.filter((it) => isReadyToFile(it, viewer));
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
                const dupes = duplicateSummary(readyItems, viewer);
                const dupeClause = dupes.count
                  ? `; ${dupes.count} join what you already have (${dupes.names.slice(0, 3).join(", ")}${
                      dupes.names.length > 3 ? ", …" : ""
                    })`
                  : "";
                const placing = placementPreview(readyItems, filing.fallbackLocation, viewer);
                const placingClause = placing.placed.length
                  ? `; ${placing.placed
                      .map((p) => `${p.count} into ${p.name}`)
                      .join(", ")}${placing.unplaced > 0 ? `, ${placing.unplaced} with no spot yet` : ""}`
                  : "";
                // WHERE a session's things go is asked of every pending item,
                // not only the ones ready to file: a session whose rows all
                // need a look lost its location control, so the one thing
                // you could settle about them had no door (#3884).
                const placeItems = sessionPlaceItems(g.items, readyItems);
                const placeIds = placeItems.map((it) => it.id);
                const sessionLoc = sessionLocation(placeItems);
                const sessionLocName = sessionLoc.id
                  ? (locsQ.data?.items ?? []).find((l) => l.id === sessionLoc.id)
                  : null;
                // A category is only worth NAMING if the destination can hold
                // one. A Bookshelf table whose fields are isbn/genre/author has
                // no category axis, so `extrasWithCategory` writes the category
                // nowhere - while the button still promised "file all 1 into
                // Book" (reported 2026-08-01). Silence beats a filing that will not
                // happen; the items still file, just without the clause.
                const sessionHasCategoryAxis = readyItems.some(
                  (it) => !!categoryAxisKey(it, menu) || !!tableCategoryAxis(menu, destinationCandidateOf(it, viewer) ?? undefined),
                );
                const sessionCat = {
                  suggestion: sessionHasCategoryAxis ? filing.category : null,
                  unanimous: sessionCategory(g.items).unanimous,
                  seen: sessionCategory(g.items).seen,
                };
            const pendingInSession = sessionLines(g.items, g.batchId ? batchMeta[g.batchId] : undefined).pending;
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
            // What this session's own lines already say (#6095): the place its
            // meta line names when the session will be added, and the shop its
            // headline names. A row says them only when its own differ; four
            // printers each repeating "Printer Room · where your other 3D
            // Printers are" under a line that said it once was the owner's
            // "repeats on every row".
            const sessionSays: SessionSays = {
              place:
                busy === 0 && readyIds.length > 0
                  ? sessionLocName
                    ? filingLabel(sessionLocName)
                    : (() => {
                        const one = suggestedPlaces(placeItems);
                        return one.length === 1 ? one[0]!.place : null;
                      })()
                  : null,
              vendor: (() => {
                const v = g.vendor ?? vendorOfItems(g.items);
                return v && sessionName(g, isReceiptSession)?.includes(v) ? v : null;
              })(),
            };
            const cardIn = (it: ScanInboxItem) => card(it, sessionSays);
            // A document that has not been read yet is named by its file.
            const source = sessionSourceOf(g);
            const unreadDocName =
              g.sourceFileId && (g.verdict.kind === "failed" || g.verdict.kind === "in_flight") ? source.docName : null;
            // A document that needs nothing is a chip in this row; the card
            // under it is for one that needs the person.
            const docChip = !!g.sourceFileId && !source.needsPerson && !!source.docName;
            // What the receipt promised, for the parcel control's label. A live
            // carrier state outranks it there; this is what fills the usual gap
            // before any carrier has said anything.
            const trackingArrival = arrivalOf(g.items);
            // The single-session page's strip on a phone (#5931): every control
            // there is a 44px target, so the receipt, Read again and Review plan
            // move into the session's ... and the date and the count keep the
            // line. Reachable in one more tap, never gone.
            const canReadAgain = isReceiptSession && !!g.batchId && !!g.sourceFileId;
            const canReviewPlan = busy === 0 && pendingInSession > 0 && g.isBatch && !!g.batchId;
            // Whether the ... is there does not wait on the read: it arriving
            // when the read finished pushed the row's controls (#7789).
            const phoneTucks = !!batchId && (docChip || canReadAgain || (pendingInSession > 0 && g.isBatch && !!g.batchId));
            // The email and parcel icons fold into ⋯ on a phone when that
            // frees a control, so the store's name gets the width (#6095).
            const emailIcon = !!source.addedBy && !(unreadDocName && source.addedBy.kind === "email");
            const parcelControl = (isReceiptSession && (g.origin === "email" || !!g.orderRef || !!g.shipmentState)) || (!!g.batchId && !!g.trackingNumber);
            const parcelOnPhone = parcelControl && !!(g.shipmentState || trackingArrival || g.trackingNumber);
            const phoneFolds = !!g.batchId && phoneFoldsSourceIcons({ email: emailIcon, parcel: parcelOnPhone, menuOtherwise: !!g.batchId && (!!themeOffer || !!mergeInto || phoneTucks) });
            const openPlan = () => {
              const first = g.items.find((it) => it.status === "pending");
              setFileEverything({
                batchId: g.batchId!,
                defaultLocationId: first?.target_location_id ?? (fileBin || null),
                scope: g.sourceFileId ? "this receipt" : "this session",
              });
            };
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
                    The filing trio (location, file, open) stays last.
                    On a phone every control on this one line is a finger's
                    target, 44 by 44, while its icon or pill stays small: the
                    box grows, never the ink (#5903). Under 360px the boxes
                    keep the height and give back the width, so the date and
                    the count still fit beside five controls. Walks:
                    a-phone-session-strip-has-finger-sized-controls. */}
                <div
                  data-session-header
                  data-testid="scan-session-header"
                  // Under 360px the inbox's strip keeps its controls' height
                  // and gives back their width (index.css, #6881); a
                  // session's own page keeps every one 44 by 44.
                  data-toolbar={batchId ? undefined : "strip"}
                  // gap-1.5, not gap-2: eleven gaps across this row, so the
                  // half-step is most of a control's width back. Clipped
                  // sideways only: the receipt's 44 px target reaches into
                  // the row's padding on a desk, and clipping it top and
                  // bottom left 34 px to press (#6881).
                  className={`flex w-full items-center gap-1.5 max-sm:gap-0 overflow-x-clip rounded-md bg-mortar-50 dark:bg-slate-800/40 px-2.5 py-1.5 max-sm:px-0 max-sm:py-0 text-left text-xs max-sm:[&>button]:min-h-[44px] ${batchId ? "max-sm:[&>button]:min-w-[44px] max-sm:[&>a]:min-w-[44px]" : "min-[360px]:max-sm:[&>button]:min-w-[44px] min-[360px]:max-sm:[&>a]:min-w-[44px] max-[359px]:[&>a]:px-1"} max-sm:[&>button]:justify-center max-sm:[&>a]:inline-flex max-sm:[&>a]:min-h-[44px] max-sm:[&>a]:items-center max-sm:[&>a]:justify-center`}
                >
                  {/* Burst select-all: grab the whole session for the
                      bulk toolbar (location / confirm / discard). The label
                      is its finger's target on a phone; the box stays small. */}
                  <label className={`contents max-sm:inline-flex max-sm:h-[44px] ${batchId ? "max-sm:w-[44px]" : "min-[360px]:max-sm:w-[44px] max-[359px]:px-1.5"} max-sm:shrink-0 max-sm:items-center max-sm:justify-center max-sm:cursor-pointer`} onClick={(e) => e.stopPropagation()}>
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
                  </label>
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
                  {isReceiptSession && !docChip &&
                    (g.sourceFileId ? (
                      // Hover shows the paper, click opens it - the one place on
                      // the row that stands for the receipt itself (2026-09-06).
                      <ReceiptPeek
                        slug={activeSlug}
                        fileId={g.sourceFileId}
                        onOpen={setViewSource}
                        title="Open the original receipt: the photo or file its lines were read from"
                        aria-label="Open the original receipt"
                        wrapClassName="shrink-0"
                        // A finger's target around a 13 px glyph (#6144); on a
                        // wide screen it reaches into the row's padding rather
                        // than making the row taller.
                        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center sm:-my-3 text-faint hover:text-accent transition"
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
                      className="font-medium text-content dark:text-mortar-100 truncate min-w-0 max-sm:flex-1 max-sm:basis-0 max-sm:min-w-0 max-sm:min-h-[44px] max-sm:text-left"
                      // The DATE is the session's identity; the word was
                      // boilerplate on every row of a view already called "By
                      // session", and truncation ate the date to keep it
                      // ("Session · Aug 1…" - the operator, 2026-08-30:
                      // "I would prioritize the date time over the word").
                      title={g.label ?? formatSessionTime(g.latest)}
                    >
                      <SessionHeadline
                        name={unreadDocName ?? sessionName(g, isReceiptSession)}
                        // Named by when it was scanned: the time drops as a
                        // whole word before anything is cut.
                        nameFits={g.label ? undefined : [formatSessionTime(g.latest), formatSessionDay(g.latest)]}
                        orderRef={isReceiptSession && g.batchId && editingPo !== g.batchId ? g.orderRef : null}
                        // A phone folds the session on the headline, so the
                        // number is text there and edited in the open session.
                        onEditRef={
                          handheld || !g.batchId
                            ? undefined
                            : () => {
                                setPoInput(g.orderRef ?? "");
                                setEditingPo(g.batchId!);
                              }
                        }
                        // A receipt's date is the date ON THE RECEIPT, not when
                        // the photo was uploaded (reported 2026-08-20); the
                        // upload time is on the tooltip.
                        date={unreadDocName ? null : g.label ? (receiptDateOf(g) ?? formatSessionDay(g.latest)) : null}
                        dateTitle={[
                          g.origin === "email" ? "Emailed." : null,
                          receiptDateOf(g) ? receiptDateWords(g.dateReading) : null,
                          `${receiptDateOf(g) ? "Uploaded" : "Scanned"} ${formatSessionTime(g.latest)}`,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        count={g.verdict.kind !== "failed" && g.verdict.kind !== "in_flight" ? g.items.length : null}
                      />
                    </SessionIdentity>
                  {docChip && !routing && (
                    <SessionDocumentChip
                      phoneHidden={!!batchId}
                      slug={activeSlug}
                      fileId={g.sourceFileId!}
                      name={source.docName!}
                      words={source.chipWords}
                      onOpen={setViewSource}
                    />
                  )}
                  {/* An unread email's headline already names its sender. */}
                  {emailIcon && source.addedBy && !routing && (
                    <span className={phoneFolds ? "contents max-sm:hidden" : "contents"}>
                      <SessionAddedByChip
                        by={source.addedBy}
                        words={addedByWords(source.addedBy)}
                        open={addedByOpen === g.key}
                        onToggle={() => setAddedByOpen((k) => (k === g.key ? null : g.key))}
                      />
                    </span>
                  )}
                  {/* ...and the offer to add one takes the SAME slot when there
                      is none. They are one fact in one place: an "+ #" sitting
                      over with the actions, while the number it creates appears
                      next to the name, made the two look like different things
                      (reported 2026-08-21). */}
                  {isReceiptSession && g.batchId && !unreadDocName && !g.orderRef && editingPo !== g.batchId && !routing && (
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
                        title={`Edited ${relativeTime(new Date(g.lastTouched).toISOString())} - a later change (a fix, or an item sent back from a commit). The session's own time is unchanged.`}
                      >
                        <Pencil size={10} />
                        {relativeTime(new Date(g.lastTouched).toISOString())}
                      </span>
                    )}
                    {g.area && (
                      <span className="hidden lg:inline shrink-0 whitespace-nowrap text-muted">· {g.area}</span>
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
                  {/* The session's rarer verbs, in one ⋯ rather than a line
                      each under the session (#3064: two spacious lines per
                      session read as nagging). "Do these belong together?"
                      costs nothing until pressed; it also surfaces on its own
                      below, but only on evidence of a shared theme. */}
                  {g.batchId && !routing && (themeOffer || mergeInto || phoneTucks || phoneFolds) && (
                    <HeaderMenu
                      width={264}
                      align="right"
                      trigger={({ toggle }) => (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            // Where a folded parcel's panel opens from (#6095).
                            menuAnchorRect.current = e.currentTarget.getBoundingClientRect();
                            toggle();
                          }}
                          aria-label="Session actions"
                          title="Session actions"
                          data-testid="session-menu"
                          // Its touch size comes from its OWN box, 32 by 44 on
                          // a phone, clear of its neighbours. At 18px it sat on
                          // the name's edge, which folds the session, so a thumb
                          // aiming at it folded it instead (the owner,
                          // 2026-09-24); a 44px-wide box was then the widest
                          // thing on the row (2026-09-25); and a 44px ::after
                          // over a 16px box lay over File, so a tap on File
                          // opened this menu (#3717). No overlay: a target
                          // never reaches past its own box.
                          className={`${themeOffer || mergeInto ? "" : "sm:hidden "}shrink-0 inline-flex min-h-6 items-center justify-center rounded p-0.5 max-sm:min-h-[44px] max-sm:min-w-[44px] max-sm:p-0 text-faint hover:text-accent`}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      )}
                    >
                      {({ close }) => (
                        <>
                          {/* The email and parcel icons, folded on a phone
                              (#6095): each item does what its icon did. */}
                          {phoneFolds && (
                            <div className="sm:hidden">
                              {emailIcon && source.addedBy && (
                                <MenuItem
                                  icon={<Mail size={13} />}
                                  label={addedByWords(source.addedBy)}
                                  onClick={() => { close(); setAddedByOpen(g.key); }}
                                />
                              )}
                              {parcelOnPhone && (
                                <MenuItem
                                  icon={<Truck size={13} />}
                                  label={`Parcel: ${g.shipmentState ? (SHIPMENT_LABEL[g.shipmentState] ?? g.shipmentState) : trackingArrival ? arrivalLabel(trackingArrival) : "tracking number"}`}
                                  onClick={() => {
                                    close();
                                    if (!g.trackingNumber) {
                                      setTrackingInput("");
                                      setEditingTracking(g.batchId!);
                                      return;
                                    }
                                    const r = menuAnchorRect.current;
                                    if (r) setTrackingRect({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 256 - 8)) });
                                    setTrackingPopover(g.batchId!);
                                  }}
                                />
                              )}
                            </div>
                          )}
                          {phoneTucks && (
                            <div className="sm:hidden">
                              {pendingInSession > 0 && g.isBatch && g.batchId && (
                                <MenuItem icon={<Zap size={13} />} label="Review plan" hint={canReviewPlan ? "What gets added to things you already have, what is filed as new, what is left for you. Nothing is written until you confirm." : "Ready once every item here is read."} disabled={!canReviewPlan} onClick={() => { close(); openPlan(); }} />
                              )}
                              {docChip && (
                                <MenuItem icon={<ReceiptText size={13} />} label={`Open ${source.docName}`} onClick={() => { close(); setViewSource(g.sourceFileId!); }} />
                              )}
                              {canReadAgain && (
                                <MenuItem icon={<RotateCcw size={13} />} label="Read again" hint="Read the original again, replacing the lines still pending" disabled={reparse.isPending && reparseBatch === g.batchId} onClick={() => { close(); reparse.mutate(g.batchId!); }} />
                              )}
                            </div>
                          )}
                          {themeOffer && (
                            <MenuItem
                              icon={<Sparkles size={13} />}
                              label={`Do these ${pendingInSession} belong together?`}
                              hint="Ask whether they share a tag or a category. Nothing runs until you press this."
                              onClick={() => {
                                setThemeAsked((prev) => new Set(prev).add(g.batchId!));
                                close();
                              }}
                            />
                          )}
                          {mergeOffer && (
                            <MenuItem
                              icon={<Undo2 size={13} />}
                              label={mergeOffer.label}
                              disabled={mergeBatches.isPending}
                              onClick={() => {
                                close();
                                void mergeBatches.mutateAsync({ from: g.batchId!, into: mergeOffer.into, intoName: mergeOffer.label.replace(/^Merge with |, above$/g, ""), itemIds: groupIds });
                              }}
                            />
                          )}
                        </>
                      )}
                    </HeaderMenu>
                  )}
                  {/* PER-SESSION UTILITIES sit LEFT of the filing trio.
                      The rightmost three controls are always location · file ·
                      open, whatever kind of session this is, so the eye lands on
                      the same place every row (reported 2026-07-30). These extras are
                      receipt-only, so leaving them on the right made the trio
                      shift column depending on whether a session came from a
                      receipt or a scan. */}
                  {!routing && (<>
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
                      className="max-sm:hidden group shrink-0 inline-flex items-center justify-center text-faint hover:text-accent transition disabled:opacity-50"
                    >
                      <span className="inline-flex items-center gap-1 max-sm:rounded-full max-sm:border max-sm:border-line/70 dark:max-sm:border-slate-700/70 max-sm:px-2 max-sm:py-1.5">
                      <RotateCcw
                        size={11}
                        className={reparse.isPending && reparseBatch === g.batchId ? "animate-spin" : ""}
                      />{" "}
                      {/* A bordered icon chip on a phone, the same height as the
                          filing trio, so the one-line row keeps its name; the
                          word appears on a wide desk. The title and aria-label
                          say what it does at every width. */}
                      <span className="hidden 2xl:inline">Read again</span>
                    </span>
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
                          placeholder="tracking # or link"
                          // The carrier's tracking link pasted whole works too:
                          // the server reads the number out of it (#5351).
                          title="The tracking number, or the tracking link from the store's email"
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
                          (g.shipmentState || trackingArrival || g.trackingNumber) && !phoneFolds
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
                            ref={trackingPanelRef}
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
                            {/* mono: a tracking number */}
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
                  </>)}

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
                  {!routing && placeIds.length > 0 && !fileBin && hasLocations && (
                    <SessionPlaceChip
                      total={placeIds.length}
                      missing={sessionLoc.missing}
                      suggested={sessionLoc.suggested}
                      suggestedNames={suggestedPlaceNames(placeItems)}
                      suggestedWhy={suggestedPlaces(placeItems).length === 1 ? suggestedPlaces(placeItems)[0]!.why : null}
                      mixed={sessionLoc.mixed}
                      placeName={sessionLocName ? filingLabel(sessionLocName) : null}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPlacingMode("set");
                        setPlacingSession(placingSession === g.key ? null : g.key);
                      }}
                    />
                  )}
                  {/* The plan-first filer for this session: adds to what you
                      have where one thing matches, files the rest as new, leaves
                      the ambiguous. File all beside it still creates from each
                      card's candidate; folding the two is a follow-up. Drawn
                      while the AI is still deciding, and pressable once it is
                      done, like File all: appearing then moved the row (#7789). */}
                  {!routing && pendingInSession > 0 && g.isBatch && g.batchId && (
                    <button
                      type="button"
                      disabled={bulkBusy || busy > 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        openPlan();
                      }}
                      title="Shows a plan first: what gets added to things you already have, what is filed as new, what is left for you. Nothing is written until you confirm."
                      aria-label="Choose for each"
                      // Not on a phone's queue: the put-away strip above is the
                      // plan door for every session, and the File N dialog
                      // carries it per session ("Review the plan first"). The
                      // single-session page has no strip, so it keeps the button.
                      className="max-sm:hidden group shrink-0 inline-flex items-center justify-center disabled:opacity-50"
                    >
                      <span className="inline-flex items-center gap-1 rounded-md border border-cobble-300 dark:border-cobble-700 group-hover:border-accent px-2 py-1 text-[11px] font-medium text-accent">
                      {/* On a phone the label says what OPENS: a plan to review,
                          not a file. "File" beside "File 2" was the owner's own
                          finding (#2982): two doors with one word. */}
                      <Zap size={11} /> <span className="sm:hidden">Review plan</span><span className="hidden lg:inline">Choose for each…</span>
                    </span>
                    </button>
                  )}
                  {/* What is ready is drawn while the rest is read, and can be
                      pressed once it is: "N finishing…" giving way to the
                      button moved the row and the caption under it (#7789). */}
                  {busy > 0 && readyIds.length === 0 ? (
                    <span
                      className="shrink-0 inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                      title="The AI is still finalizing some items - names, covers and routing may still change"
                    >
                      <Loader2 size={9} className="animate-spin" /> {busy} finishing…
                    </span>
                  ) : readyIds.length > 0 ? (
                    <button
                      type="button"
                      disabled={bulkBusy || busy > 0}
                      aria-busy={busy > 0 || undefined}
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
                      title={busy > 0 ? `Ready once ${busy} more ${busy === 1 ? "is" : "are"} read - names, covers and routing may still change` : (
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
                      )}
                      className="group shrink-0 inline-flex items-center justify-center disabled:opacity-50"
                    >
                      <span className="inline-flex items-center gap-[4px] rounded-md bg-cobble-600 group-hover:bg-cobble-700 px-[8px] py-1 text-[11px] font-medium text-white">
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
                          {/* Not on a phone: the place chip beside it already
                              wears the pin, and the strip needs the width
                              for its 44px targets (#5903). */}
                          <MapPin size={11} className="max-sm:hidden" />
                          {/* ONE text node. Each of these used to be its own
                              flex child, so the container's gap-1 landed between
                              "File", "all" and the count on top of the spaces
                              already in them — a visible double space
                              (reported 2026-08-21). */}
                          <span>
                            {bulkProgress ?? (
                              <>
                                <span data-testid="session-file">
                                  {/* The phone gets the verb and the count; the
                                      desk gets the install word too. Both come
                                      from one resolver call, so they cannot
                                      disagree about what the tap covers (#3393). */}
                                  <span className="lg:hidden">{sessionAction.shortLabel}</span>
                                  <span className="max-lg:hidden">{sessionAction.label}</span>
                                </span>
                              </>
                            )}
                          </span>
                          {sessionCat.suggestion ? (
                            <span className="hidden lg:inline max-w-[9rem] truncate opacity-80">
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
                                <span data-testid="session-file">
                                  {/* The phone gets the verb and the count; the
                                      desk gets the install word too. Both come
                                      from one resolver call, so they cannot
                                      disagree about what the tap covers (#3393). */}
                                  <span className="lg:hidden">{sessionAction.shortLabel}</span>
                                  <span className="max-lg:hidden">{sessionAction.label}</span>
                                </span>
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
                            <span className="hidden lg:inline max-w-[9rem] truncate opacity-80">
                              as {sessionCat.suggestion}
                            </span>
                          ) : null}
                        </>
                      )}
                    </span>
                    </button>
                  ) : pendingInSession > 0 && sessionAction.reviews === 0 && sessionAction.blocked > 0 ? (
                    // Nothing here is this person's to look at: every row is
                    // waiting on an admin, and each says what to ask for.
                    <span
                      className="shrink-0 inline-flex items-center gap-1 text-amber-600/80 dark:text-amber-400/80 text-[10px] font-medium"
                      title="Every item still here is waiting on an admin - each row says what to ask for"
                    >
                      waiting on an admin
                    </span>
                  ) : pendingInSession > 0 ? (
                    // Under 360px the words cost the store's name the 60px it
                    // needs (#6095): the alert says it, and the rows say why.
                    <span
                      className="shrink-0 inline-flex items-center gap-1 text-amber-600/80 dark:text-amber-400/80 text-[10px] font-medium"
                      title="Every item still here needs a manual look - open the cards to give each a name or destination"
                    >
                      <AlertCircle size={13} aria-hidden className="min-[360px]:hidden" />
                      <span className="max-[359px]:sr-only">needs review</span>
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
                      <span className="lg:hidden">→</span>
                      <span className="max-lg:hidden">open →</span>
                    </Link>
                  )}
                </div>
                {!collapsed && (
                  <div className="space-y-2">
                  {(() => {
                    // What the button cannot hold, and a phone has no tooltip:
                    // every destination, what turning a collection on means,
                    // and the session's place (#4577); and which order it is,
                    // its number the link to the purchase. One line (#6095).
                    // While the read finishes, the line says what the
                    // "finishing" chip's tooltip says, and holds the place the
                    // caption arrives in (#7789).
                    const caption = readyIds.length > 0 ? sessionAddCaption(readyIds.length, sessionAction.tables, sessionAction.off, placeForFilingLine(sessionLocName ? filingLabel(sessionLocName) : null, suggestedPlaces(placeItems))) : busy > 0 ? "Names, covers and where they go may still change" : null;
                    return (
                      <SessionMetaLine
                        parts={[
                          caption && <span data-testid="session-add-caption">{caption}</span>,
                          isReceiptSession && g.batchId && <SessionOrderRef orderRef={g.orderRef} purchaseId={batchMeta[g.batchId]?.purchases_order_id} />,
                        ]}
                      />
                    );
                  })()}
                    {/* The header's "Added by", opened: when, and how. */}
                    {source.addedBy && addedByOpen === g.key && (
                      <div data-testid="session-added-by-detail" className="px-2.5 text-xs text-muted">
                        {addedByWords(source.addedBy)}, {formatSessionTime(g.latest)}
                        {source.addedBy.kind === "email" ? "" : `, ${addedByHow(source.addedBy)}`}.
                      </div>
                    )}
                    {g.batchId && batchMeta[g.batchId]?.purchase_pending && <KeepAsPurchase slug={activeSlug} batchId={g.batchId} />}
                    {/* The document itself, when it needs the person: its
                        first page, its name, and where the reading stands
                        (#4523). One that needs nothing is the header's chip. */}
                    {g.sourceFileId && source.needsPerson && (
                      <DocumentSessionCard
                        slug={activeSlug}
                        fileId={g.sourceFileId}
                        name={source.docName ?? "Document"}
                        state={documentStateWords(g.verdict, g.items)}
                        onOpen={setViewSource}
                      />
                    )}
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
                    {splitLayoutOf(g.shown, splitParents).map((e) =>
                      e.kind === "item" ? (
                        cardIn(e.item)
                      ) : (
                        <SplitLineGroup
                          key={`split:${e.parentId}`}
                          parentId={e.parentId}
                          summary={e.summary}
                          parentCard={e.parentItem ? cardIn(e.parentItem) : null}
                          parts={e.parts}
                          renderPart={cardIn}
                          onAddAll={(ids) => confirmItemsToTheirCandidate(ids)}
                          routeOf={splitRouteOf}
                          menu={menu}
                        />
                      ),
                    )}
                    {/* Merge lives INSIDE the expanded session (reveal-to-use),
                        not on the collapsed header where its old ↓ was mistaken
                        for the accordion and folded sessions by accident. It's a
                        rare re-unify action; every merge is Undo-able via toast. */}
                    {/* A receipt is already one group; asking whether its
                        lines belong together is noise (2026-09-06). */}
                    {/* Only on evidence (the rows already share a category
                        that some still lack) or when asked from the session's
                        ⋯ (#3064): a question on every session read as nagging. */}
                    {themeOffer && (themeAsked.has(g.batchId!) || themeEvidence) && (
                      <ScanSessionTheme
                        slug={activeSlug}
                        batchId={g.batchId!}
                        itemIds={g.items.filter((i) => i.status === "pending").map((i) => i.id)}
                        evidence={themeEvidence}
                      />
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
                count={placingMode === "set" ? placeIds.length : readyIds.length}
                category={filing.category}
                currentLocationId={sessionLoc.id}
                suggestion={sessionPlaceSuggestion(g.items)}
                onPick={(v) => {
                  setPlacingSession(null);
                  if (placingMode === "set")
                    // Fill only items with no location when the set is MIXED -
                    // the modal opened with no current value then, and a blanket
                    // write would flatten every per-item choice silently.
                    void applySessionLocation(placeIds, v, sessionLoc.mixed);
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
        {/* After the rows, never above them: nothing but the counts and actions
            sits above the first row (e2e/walks/the-scan-inbox-starts-with-its-rows). */}
        <p className="hidden sm:block text-xs text-faint dark:text-slate-500" data-testid="paste-anywhere-hint">
          Paste or drop a picture, or a product's name and link, anywhere on this page to add it.
        </p>
        {/* Infinite-scroll sentinel — pulls the next page as it nears the view. */}
        {hasNextPage && (
          <div ref={loadMoreRef} className="py-4 text-center text-xs text-faint">
            {isFetchingNextPage ? "loading more…" : ""}
          </div>
        )}
        </>
        )}
      </div>
      )}

      {wedgeBinAdjust && (
        <BinAdjustModal
          locationId={wedgeBinAdjust.locationId}
          locationName={wedgeBinAdjust.locationName}
          item={wedgeBinAdjust.item}
          onClose={() => setWedgeBinAdjust(null)}
          onAddSomethingElse={() => {
            setFileBin(wedgeBinAdjust.locationId);
            toast.success(`Filing into ${wedgeBinAdjust.locationName}. Scan the new item`);
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
            if (next) later.after("advance", 0, () => openSheet(next.id));
            else later.after("advance", 0, () => setGalleryFocusId(null));
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
                sessionSource={sessionSourceByItem.get(focus.id) ?? null}
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

      {listQuiet && recentlyDeleted.length > 0 && (
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
              {recentlyDeleted.map((d) => {
                const recovery = scanDeletedRecovery(d.suggested_metadata as Record<string, unknown> | null);
                const keptName = recovery.kind === "undo_combine" ? (() => { const k = items.find((i) => i.id === recovery.into); return k ? displayName(k) : null; })() : null;
                return (
                <div
                  key={d.id}
                  className="flex items-center gap-2 rounded-md border border-line dark:border-slate-700 bg-surface/50 dark:bg-slate-800/30 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-muted truncate">
                      {displayName(d) ?? d.barcode_text ?? "Unknown scan"}
                    </div>
                    {d.barcode_text && displayName(d) && (
                      // mono: a barcode's digits
                      <div className="text-[10px] font-mono text-faint truncate">{d.barcode_text}</div>
                    )}
                    {recovery.kind === "in_group_photo" && (
                      <div className="text-[10px] text-faint truncate">✂ piece of a split that was undone; the group photo is back in the inbox</div>
                    )}
                    {recovery.kind === "undo_combine" && (
                      <div className="text-[10px] text-faint truncate">
                        combined into {keptName ? `"${keptName}"` : "another scan"}; its quantity lives there
                      </div>
                    )}
                  </div>
                  {/* The row offers the way back the server accepts
                      (scan-recovery.ts), so pressing it never meets a refusal
                      naming an action that is not here (#3639). */}
                  {recovery.kind === "restore" ? (
                    <button
                      type="button"
                      onClick={() => restore.mutate(d.id)}
                      disabled={restore.isPending}
                      className="shrink-0 inline-flex items-center gap-1 text-xs rounded border border-line px-2 py-1 text-muted hover:text-content disabled:opacity-50"
                    >
                      <RotateCcw size={12} /> {SCAN_UNDO_ACTIONS.restore}
                    </button>
                  ) : recovery.kind === "undo_combine" ? (
                    <button
                      type="button"
                      data-testid="undo-combine"
                      onClick={() => uncombine.mutate(d.id)}
                      disabled={uncombine.isPending}
                      title="Put both scans back in the inbox, each with its own quantity"
                      className="shrink-0 inline-flex items-center gap-1 text-xs rounded border border-line px-2 py-1 text-muted hover:text-content disabled:opacity-50"
                    >
                      <RotateCcw size={12} /> {SCAN_UNDO_ACTIONS.undoCombine}
                    </button>
                  ) : null}
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {listQuiet && recentlyCommitted.length > 0 && (
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
                    <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-line/70 dark:border-slate-700/70">
                      <span className="text-xs text-muted">
                        {grp.filed.length} item{grp.filed.length === 1 ? "" : "s"} from one session
                      </span>
                      <div className="flex-1" />
                      {grp.splits.length > 0 && (
                        <label className="inline-flex items-center gap-1 text-[11px] text-faint">
                          <input
                            type="checkbox"
                            data-testid="also-undo-split"
                            checked={!!alsoUndoSplit[grp.key]}
                            onChange={(e) => setAlsoUndoSplit((m) => ({ ...m, [grp.key]: e.target.checked }))}
                          />
                          Also undo the split
                        </label>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          void sendBackSession(
                            grp.key,
                            grp.batchId,
                            grp.filed.map((i) => i.id),
                            grp.splits.map((sp) => sp.parent),
                          )
                        }
                        disabled={sendingBackAll === grp.key}
                        className="shrink-0 inline-flex items-center gap-1 text-xs rounded border border-line px-2 py-1 text-muted hover:text-content disabled:opacity-50"
                      >
                        <RotateCcw size={12} className={sendingBackAll === grp.key ? "animate-spin" : ""} /> Send whole session back
                      </button>
                    </div>
                    {grp.splits.map((sp) => (
                      <div key={sp.parent.id} data-testid="split-parent" id={`committed-${sp.parent.id}`}>
                        <div className="flex items-center gap-2 px-3 py-1 pl-4 bg-surface/60 dark:bg-slate-800/40">
                          <div className="min-w-0 flex-1 truncate text-[11px] text-faint">
                            ✂ {displayName(sp.parent) ?? "Group photo"} · split into {splitPieces(sp.parent)}
                          </div>
                          <button
                            type="button"
                            onClick={() => undoSplit.mutate(sp.parent.id)}
                            disabled={undoSplit.isPending || sendingBackAll === grp.key}
                            className="shrink-0 text-xs text-faint hover:text-content disabled:opacity-50"
                          >
                            Undo split
                          </button>
                        </div>
                        {revertFailures[sp.parent.id] && committedFailure(sp.parent.id, grp.key)}
                        {sp.children.map((d) => committedFiledRow(d, grp.key, "pl-9"))}
                      </div>
                    ))}
                    {grp.loose.map((d) => committedFiledRow(d, grp.key, "pl-6"))}
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
                          <div className="text-[10px] text-faint truncate">✂ split into {splitPieces(grp.items[0])} items</div>
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
                          <RotateCcw size={12} /> {SCAN_UNDO_ACTIONS.sendBack}
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

      <ScanImportModal
        slug={activeSlug}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) })}
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
          filename={documentNames.get(viewSource) ?? sourceFileNames.get(viewSource) ?? null}
          onClose={() => setViewSource(null)}
        />
      )}
    </div>
    </ScanTwinsContext.Provider>
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

type SessionLine = { suggested_metadata?: unknown };
const metaOf = (i: SessionLine) => (i.suggested_metadata ?? {}) as { receipt_vendor?: unknown; receipt_date?: unknown; receipt_document?: unknown; receipt_source?: unknown };

/** The shop a session's lines were read from, when the batch did not keep it. */
function vendorOfItems(items: readonly SessionLine[]): string | null {
  for (const i of items) {
    const v = metaOf(i).receipt_vendor;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** The date printed on the document, as a local calendar day. */
function documentDateOf(items: readonly SessionLine[]): Date | null {
  for (const i of items) {
    const d = metaOf(i).receipt_date;
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const [y, m, day] = d.split("-").map(Number);
    return new Date(y!, m! - 1, day!);
  }
  return null;
}

function isBillOfSaleSession(items: readonly SessionLine[]): boolean {
  return items.some((i) => metaOf(i).receipt_document === "bill-of-sale");
}

function receiptSourceOf(items: readonly SessionLine[]): "scanned-pdf" | "pdf" | "photo" | "text" | null {
  for (const i of items) {
    const v = metaOf(i).receipt_source;
    if (v === "scanned-pdf" || v === "pdf" || v === "photo" || v === "text") return v;
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

// The target picker lists the workspace's ACTUAL tables (instances like
// "Yarn" + each enabled module's default), straight from the same menu
// the matchmaker prompts with — the web hardcodes no module names (core
// tenet). Picking a table renders THAT table's fields, pre-seeded from
// the matchmaker's extraction when a chip routed here.
