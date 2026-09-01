// /scan — the inbox review queue, photo-inbox-grade.
import { createPortal } from "react-dom";
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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RepurchaseControls } from "../components/RepurchaseControls";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, CheckCircle, ChevronDown, Download, ExternalLink, FileText, Flag, Image as ImageIcon, ImagePlus, LayoutGrid, Library, List, Loader2, MapPin, MonitorSmartphone, MoreHorizontal, Pencil, ReceiptText, RefreshCw, RotateCcw, ScanLine, Scissors, Search, Sparkles, Tag, Trash2, Truck, Upload, Wand2, X, Zap } from "lucide-react";
import { Modal, useImageSrc, useOverlayOpenFlag, useToast, usePageTitle, colorSwatch, wantsSwatch } from "@cobblr/platform-web";
import { ScanImportModal } from "../components/ScanImportModal";
import { ExportInboxModal } from "../components/ExportInboxModal";
import { CameraCaptureSheet } from "../components/CameraCaptureSheet";
import { ContributedDetailPanels } from "../panels/registry";
import { LocationChipPicker } from "../components/LocationChipPicker";
import { SessionLocationModal } from "../components/SessionLocationModal";
import { OrganizePlanSheet, SortingPlanView } from "../components/OrganizePlanSheet";
import { OrganizeWalkSheet } from "../components/OrganizeWalkSheet";
import { LiveSortSheet } from "../components/LiveSortSheet";
import { ImageSearchPicker } from "../components/ImageSearchPicker";
import { ImageLightbox, type LightboxItem } from "../components/ImageLightbox";
import { ReceiptSourceViewer, type ReceiptMoney } from "../components/ReceiptSourceViewer";
import { canRerunLookup } from "../lib/scanRerun";
import { TrackedMatchBanner } from "../components/TrackedMatchBanner";
import { BinAdjustModal } from "../components/BinAdjustModal";
import { PairPhoneButton } from "../components/PairPhoneButton";
import { HeaderMenu, MenuFilterLine, MenuHead, MenuItem, MenuNote, MenuSep } from "../components/HeaderMenu";
import { ReceiptAddressChip, ReceiptAddressMenuBlock } from "../components/ReceiptAddressChip";
import { classifyFiles, classifyOmni, clipboardImages, omniPlaceholder } from "./omniIntake";
import { catalogUndoHistory, catalogUndoLabel, catalogUndoTitle } from "./scanCatalogUndo";
import { shouldPersistNameEdit } from "./scanNameEdit";
import { ChipFields, type ChipFieldDef, type ChipFieldType } from "../components/ChipFields";
import { useAiStatus, AiOffNotice } from "../components/AiStatusNotice";
export { useAiStatus, AiOffNotice } from "../components/AiStatusNotice";
import { decideLocationScan, filingLabel } from "../lib/scanFiling";
import { measureDevice, photoPressAction } from "../lib/photoDevice";
import { scanNotesPlacement } from "../lib/scanNotes";
import { shouldOfferSplit } from "../lib/splitOffer";
import { leadPhoto, photoOrder, photoUnverified } from "../lib/scanPhoto";
import { findCombineClusters } from "../lib/scanCombine";
import { entryKey, withRoutedInstances, pickDestinationKey } from "../lib/scanDestination";
import {
  type AiStatus,
  ApiError,
  api,
  type ImageOption,
  type OrganizeStoredPlan,
  type ScanInboxItem,
  type ScanCandidate,
  type ScanMenuEntry,
  type TrackedMatch,
} from "../lib/api";
import { qrTokenFromUrl } from "@cobblr/platform-contract/qr-token";
import { isScanStale, needsScanReview } from "@cobblr/platform-contract/scan-triage";
import { matchParentType, readField } from "../lib/parent-type-match";
import { isRerunInFlight, itemEnriching } from "./scan-status";
import { baseKind, confirmBodyFor, isReadyToFile } from "./scanFileAll";
import { resolveInstanceForFiling } from "./scanInstall";
import { arrivalLabel, arrivalOf } from "./scanArrival";
import type { BundleInstallSummary } from "../lib/api";
import { installToastLine } from "../lib/installSummary";
import { looksLikeContainer, nextBinName } from "./scanContainer";
import {
  sessionCategory,
  sessionFilingReadiness,
  sessionLocation,
  declaredCategoryAxis,
  categoryAxisKey,
  categoryChipLabel,
} from "./sessionCategory";
import { usePublishChatContext } from "../lib/chat-context";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";
import { resolveSessionBatch, clearScanSession, readScanSession, isSessionFresh, SESSION_GAP_MS } from "../lib/scanSession";
import { tabBrowserId } from "../hooks/useBrowserDrive";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useFieldPresentation } from "../lib/useFieldPresentation";
import { useAuth } from "../auth/AuthContext";
import { destinationLabel, betterDestination, type DestinationTable } from "@cobblr/platform-contract";

/** Base-kind fallback for when the scan menu can't load — the menu
 *  (GET /modules/core-scan/menu) is the real source of truth and lists
 *  the workspace's ACTUAL tables ("Yarn"), not module names. */
const FALLBACK_MENU: ScanMenuEntry[] = [
  { module: "inventory", instance: null, kind: "inventory:part", noun: "part", label: "Inventory part", fields: [] },
  { module: "assets", instance: null, kind: "assets:asset", noun: "asset", label: "Asset", fields: [] },
  { module: "machines", instance: null, kind: "machines:machine", noun: "machine", label: "Machine", fields: [] },
];

// ── scan-drives-screen (Phase 1) ─────────────────────────────────────────────
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

/** Compact relative time for an inbox item's last touch ("just now", "10 min
 *  ago", "3 h ago", "2 d ago") — so you can see how stale this listing is. */
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

/** True when the item never got a real identity — no name, or the AI's
 *  "couldn't identify it" placeholder ("Unknown Item"). Used to suppress the
 *  catalog photo search (searching "Unknown Item" returns junk) and the default
 *  commit target (don't pre-route an unidentified thing into Inventory). */
function isUnidentified(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  const lc = n.toLowerCase();
  if (!n || lc === "unknown" || lc === "unknown item" || lc === "unidentified" || lc.startsWith("unknown ")) {
    return true;
  }
  // Junk placeholders already stored before the backend guard landed: a run of
  // one character ("XXXXXXXX") or too short to be a product.
  const alnum = n.replace(/[^a-z0-9]/gi, "");
  return alnum.length < 3 || /(.)\1{3,}/i.test(alnum);
}

/** How a combine offer was found — drives the banner's wording + which item it
 *  keeps. "name" = same brand + product words; "barcode" = an OCR-read barcode
 *  that's a near-match to one you scanned earlier. */
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

/** The creator of a titled work (author/director/artist/…) from the item's
 *  candidate fields — a better subtitle than the publisher for books/media.
 *  Null for a normal product (no creator field), so the brand shows as before. */
function creatorOf(it: { suggested_candidates?: Array<{ fields?: Record<string, unknown> }> }): string | null {
  const keys = ["author", "director", "artist", "composer", "writer"];
  for (const c of it.suggested_candidates ?? []) {
    for (const k of keys) {
      const v = (c.fields ?? {})[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Collapse candidates that read as the SAME chip to a human — i.e. share a
 *  display LABEL. This catches both the matchmaker proposing one table twice AND
 *  the confusing case of two DIFFERENT tables that happen to be named the same
 *  (e.g. an `assets::bookshelf` and an `inventory::…bookshelf`, both labelled
 *  "Bookshelf") — the user can't tell "Bookshelf · 3 fields" from "Bookshelf · 1
 *  field" apart, so we keep the richer-filled one and drop the duplicate label.
 *  (Falls back to module::instance when a candidate has no label.) */
function dedupeCandidates(cands: ScanCandidate[]): ScanCandidate[] {
  const byKey = new Map<string, ScanCandidate>();
  for (const c of cands) {
    const key = (c.label ?? "").trim().toLowerCase() || `${c.module}::${c.instance ?? ""}`;
    const prev = byKey.get(key);
    if (!prev || Object.keys(c.fields ?? {}).length > Object.keys(prev.fields ?? {}).length) byKey.set(key, c);
  }
  return [...byKey.values()];
}

/** A vendor/URL resolver (a Polar spool QR, …) stows its structured parse under
 *  `suggested_metadata.fields` — keys aligned to field-def names (size,
 *  batch_code, material, color, …). Pull that nested object out as a flat map. */
function parsedScanFields(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const f = meta?.fields;
  return f && typeof f === "object" && !Array.isArray(f) ? (f as Record<string, unknown>) : {};
}

/** "batch_code" -> "Batch code". Display label for a parsed field we don't have
 *  a field-def label for (it lands on a linked entity, e.g. the filament type). */
function humanizeKey(k: string): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// `colorSwatch` (a colour value → CSS colour) now lives in @cobblr/platform-web
// so the scan form and the shared EntityThumb agree on what renders as a
// swatch. Imported at the top of this file.

/** The at-the-moment-of-pain variant: a nameless miss in the confirm flow. */
export function AiOffMissHint({ status }: { status: AiStatus | null }) {
  if (!status || status.available) return null;
  return (
    <p className="text-xs text-amber-600 dark:text-amber-400">
      No catalog match - and no AI is set up to identify it, so name it
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

/** Inline "name it yourself" for a scan that couldn't be auto-identified (a bare
 *  photo with no vision provider). Naming it triggers a server re-match, so the
 *  heuristic (or AI) suggests a table + fills fields — a one-field entry instead
 *  of a dead end. Stops click propagation so typing doesn't expand the card. */
function NameItInline({ slug, itemId }: { slug: string; itemId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const mut = useMutation({
    mutationFn: () => api.updateScanItem(slug, itemId, { name: name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      toast.success("Got it - finding the right table…");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <div className="mt-1.5 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="What is this? e.g. blue worsted yarn"
        aria-label="Name this item"
        className="input !py-1 !text-xs flex-1"
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) mut.mutate();
        }}
      />
      <button
        type="button"
        disabled={!name.trim() || mut.isPending}
        onClick={() => mut.mutate()}
        className="shrink-0 rounded bg-cobble-600 text-white text-xs font-medium px-2.5 py-1 hover:bg-cobble-700 transition disabled:opacity-50"
      >
        Identify
      </button>
    </div>
  );
}

/** Inline corrector for a barcode item whose resolved name is wrong. PATCHes the
 *  name (which, server-side, reports the fix to the shared Barcode Intelligence
 *  DB so the next scan of this UPC is right everywhere). Pre-filled with the
 *  current name so it's a quick edit, not a retype. */
/** The carrier vocabulary in words a person uses. Six states, so a table
 *  rather than a chain of conditions — and an unmapped one falls through to
 *  itself instead of rendering blank. */
/** How a code's origin is worded on a card. Keys are the values
 *  modules/core-scan/src/services/barcode-source.ts stamps; a scan stamps
 *  nothing and needs no note. */
const BARCODE_SOURCE_NOTE: Record<string, string | undefined> = {
  "ai-photo": "read from photo",
  receipt: "read from the receipt",
};

const SHIPMENT_LABEL: Record<string, string> = {
  pre_transit: "Label created",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  exception: "Needs attention",
  unknown: "No information yet",
};

function CorrectNameInline({
  slug,
  itemId,
  initial,
  onDone,
}: {
  slug: string;
  itemId: string;
  initial: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(initial);
  const mut = useMutation({
    mutationFn: () => api.updateScanItem(slug, itemId, { name: name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      toast.success("Fixed - thanks, that sharpens future scans of this barcode.");
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <div className="mt-1 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <input
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        aria-label="Correct the product name"
        className="input !py-1 !text-xs flex-1"
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) mut.mutate();
          if (e.key === "Escape") onDone();
        }}
      />
      <button
        type="button"
        disabled={!name.trim() || mut.isPending}
        onClick={() => mut.mutate()}
        className="shrink-0 rounded bg-amber-600 text-white text-xs font-medium px-2.5 py-1 hover:bg-amber-700 transition disabled:opacity-50"
      >
        Fix
      </button>
      <button type="button" onClick={onDone} className="shrink-0 text-xs text-faint px-1.5 py-1">
        Cancel
      </button>
    </div>
  );
}

/** Where scans confirm into — a module instance (e.g. the "yarn" inventory
 *  instance), passed via the URL when you scan from an instance's table. */
export type ScanTarget = { instance: string; module: string; kind: string; label: string };

export 
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

export function ScanPage() {
  usePageTitle("Scan");
  const { activeSlug, activeOrg } = useActiveOrg();
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
  const [uploading, setUploading] = useState(false);
  // Progress across a multi-photo selection ({done,total}); null when idle or a
  // single photo (which needs no counter). Drives the "adding 3/8…" button label.
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);

  // Upload one OR many photos as a single batch — every photo in a multi-select
  // gets the SAME scan_batch_id, so the inbox groups them as one session (the
  // session-group logic keys on scan_batch_id). We resolve that batch ONCE up
  // front rather than per-file, so N photos never scatter into N sessions or
  // race to mint N batches. Each photo reveals in the inbox the moment it lands
  // (per-file invalidate); the AI identification runs server-side in the
  // background exactly as for a single photo.
  async function uploadPhotos(files: File[]) {
    if (files.length === 0) return;
    const multi = files.length > 1;
    setUploading(true);
    if (multi) setUploadProgress({ done: 0, total: files.length });
    try {
      // "inbox": a photo added at the desk is not part of the shelf-walk the
      // camera is in the middle of. Sharing the camera's session key put a TV
      // uploaded from the inbox into a session of two teas scanned minutes
      // earlier (reported 2026-08-30). Uploads still cluster with each other.
      const sessionBatch =
        batchId ??
        (await resolveSessionBatch(
          activeSlug,
          () => api.createScanBatch(activeSlug).then((b) => b.id).catch(() => null),
          Date.now(),
          "inbox",
        )) ??
        undefined;
      let ok = 0;
      for (const file of files) {
        try {
          const rec = await api.uploadFile(activeSlug, file);
          await api.scanBarcode(activeSlug, {
            source_kind: "photo",
            image_file_id: rec.id,
            scan_batch_id: sessionBatch,
          });
          ok++;
          // Reveal each as it lands, so a long selection fills in progressively.
          void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
        } catch (e) {
          toast.error(`${file.name}: ${e instanceof ApiError ? e.message : String(e)}`);
        }
        if (multi) setUploadProgress({ done: ok, total: files.length });
      }
      if (ok === 1) toast.success("Photo added - AI is identifying it");
      else if (ok > 1) toast.success(`${ok} photos added as one batch — AI is identifying them`);
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // A receipt PDF/photo → core-ai pulls out the line items → one inbox row
  // per item, each triaged into a part below like any other scan.
  async function importReceiptFile(fileId: string, force: boolean) {
    const out = await api.scanReceipt(activeSlug, fileId, { origin: "upload", force });
    if (out.duplicate) {
      const ex = out.existing;
      // Already imported this exact receipt (same vendor + order #). Offer to
      // import it anyway rather than silently duplicating every line.
      toast.action(
        `You already imported this receipt${ex.order_ref ? ` (#${ex.order_ref})` : ""}${ex.vendor ? ` from ${ex.vendor}` : ""} — ${ex.item_count} item${ex.item_count === 1 ? "" : "s"} already in your inbox.`,
        {
          actionLabel: "Import anyway",
          duration: 10000,
          onAction: () => void importReceiptFile(fileId, true),
        },
      );
      return;
    }
    const n = out.receipt.item_count;
    const from = out.receipt.vendor ? ` from ${out.receipt.vendor}` : "";
    const found = `${force ? "Imported" : "Found"} ${n} item${n === 1 ? "" : "s"}${from}`;
    // Lines that do not add up to what was charged are the dangerous kind of
    // nearly-right: each one looks plausible on its own. Say both numbers and
    // let the reader judge, rather than a cheerful count that hides a dropped
    // line or a coupon that never got applied.
    if (out.receipt.lines_reconcile === false && out.receipt.total != null) {
      toast.info(
        `${found}, but they add up to ${out.receipt.lines_total.toFixed(2)} and the receipt says ` +
          `${out.receipt.total.toFixed(2)}. Check for a discount, or a line that did not come through.`,
        { duration: 12000 },
      );
    } else {
      toast.success(`${found} — review below`);
    }
    void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
  }

  // A receipt PDF/photo → core-ai pulls out the line items → one inbox row
  // per item, each triaged into a part below like any other scan.
  async function uploadReceipt(file: File) {
    setUploading(true);
    try {
      const rec = await api.uploadFile(activeSlug, file);
      await importReceiptFile(rec.id, false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUploading(false);
      if (receiptRef.current) receiptRef.current.value = "";
    }
  }

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

  const aiStatus = useAiStatus();
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
    const m: Record<string, { label: string | null; origin: string | null; source_file_id: string | null; order_ref: string | null; tracking_number: string | null; shipment_state: string | null; shipment_description: string | null; shipment_location: string | null }> = {};
    for (const p of list.data?.pages ?? []) Object.assign(m, p.batches ?? {});
    return m;
  }, [list.data]);
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
  const reviewCount = items.filter(needsReview).length;
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
      toast.success(`Combined into one — ${fresh.suggested_name ?? "item"}${qty > 1 ? ` ×${qty}` : ""}`);
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
          <div className="truncate text-sm text-content dark:text-mortar-100">{item.suggested_name ?? "(unnamed)"}</div>
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
                  ? "Combines their details into one, keeps the scanned barcode."
                  : `Merges to ×${totalQty}, keeps the scanned barcode.`}
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
            {cluster.items.map((c) => c.suggested_name).filter(Boolean).join(" · ")}.{" "}
            {isUnique ? "Combine their details into one?" : `Combine into one (×${totalQty})?`}
          </span>
        </div>
        <button
          type="button"
          disabled={combineMut.isPending}
          onClick={() => combineMut.mutate({ ids, ...(isUnique ? {} : { keepId: keep.id }) })}
          className="shrink-0 rounded bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {isUnique ? "Combine details" : "Combine"}
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
          g = { key: it.scan_batch_id, isBatch: true, batchId: it.scan_batch_id, items: [], latest: 0, lastTouched: 0, area: null, label: meta?.label ?? null, origin: meta?.origin ?? null, sourceFileId: meta?.source_file_id ?? null, orderRef: meta?.order_ref ?? null, trackingNumber: meta?.tracking_number ?? null, shipmentState: meta?.shipment_state ?? null, shipmentDescription: meta?.shipment_description ?? null, shipmentLocation: meta?.shipment_location ?? null };
          byBatch.set(it.scan_batch_id, g);
          groups.push(g);
        }
      } else {
        if (!pseudo || !Number.isFinite(t) || pseudoLastT - t > SESSION_GAP_MS) {
          pseudo = { key: `gap:${it.id}`, isBatch: false, batchId: null, items: [], latest: 0, lastTouched: 0, area: null, label: null, origin: null, sourceFileId: null, orderRef: null, trackingNumber: null, shipmentState: null, shipmentDescription: null, shipmentLocation: null };
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
    return groups.sort((a, b) => b.latest - a.latest);
  }, [visibleItems, batchMeta]);

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
  const undoCommittedIds = async (ids: string[]) => {
    if (ids.length === 0) return;
    reportRevert(await revertIds(ids));
  };

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
      toast.success(`Scanned: ${item.suggested_name ?? `Barcode ${item.barcode_text}`}`);
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
      const qrToken = qrTokenFromUrl(code);
      if (!qrToken) {
        wedgeScan.mutate(code);
        return;
      }
      // A scanned LOCATION label sets the active filing bin (and nests a container
      // under the current bin) instead of staging an item — the scan-to-set
      // flow. Any other QR stages as a normal scan.
      const token = qrToken;
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
  const purchasesEnabled = (modulesQ.data?.items ?? []).some(
    (m) => m.name === "purchases" && m.enabled,
  );
  const receiptGroups = useMemo(() => {
    const groups = new Map<string, { vendor: string | null; count: number }>();
    for (const it of items) {
      if (it.status === "resolved" || it.status === "discarded") continue;
      const meta = it.suggested_metadata as Record<string, unknown> | undefined;
      const gid = typeof meta?.receipt_group_id === "string" ? meta.receipt_group_id : null;
      if (!gid) continue;
      const g = groups.get(gid) ?? {
        vendor: typeof meta?.receipt_vendor === "string" ? (meta.receipt_vendor as string) : null,
        count: 0,
      };
      g.count += 1;
      groups.set(gid, g);
    }
    return [...groups.entries()].map(([groupId, g]) => ({ groupId, ...g }));
  }, [items]);
  const confirmGroup = useMutation({
    mutationFn: (groupId: string) => api.confirmReceiptGroup(activeSlug, groupId),
    onSuccess: (r) => {
      const ids = r.confirmed.filter((c) => !c.error && c.itemId).map((c) => c.itemId);
      const n = ids.length;
      // The server reports per-line failures IN the response - "4 lines, 2
      // failed" must not read as a clean "2 items" (2026-08-25 audit).
      const failedN = r.confirmed.filter((c) => c.error).length;
      const trouble = failedN ? ` · ${failedN} line${failedN === 1 ? "" : "s"} failed and stayed in the inbox` : "";
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-inbox-resolved", activeSlug] });
      // Undo inline — a mis-tapped "Confirm as purchase order" sends every line
      // back to the inbox (and removes the created part), unsorted, in one tap.
      toast.action(
        (r.order_id
          ? `Purchase order created — ${n} item${n === 1 ? "" : "s"}${r.vendor ? ` from ${r.vendor}` : ""}`
          : `Confirmed ${n} item${n === 1 ? "" : "s"} (enable Purchases to group them into an order)`) + trouble,
        {
          actionLabel: "Undo",
          duration: 8000,
          onAction: () => void undoCommittedIds(ids),
        },
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Multiple pending receipts → one collapsible banner instead of a stack of
  // "Confirm as purchase order" rows (reported 2026-07-24). "Confirm all" turns each
  // receipt into its OWN purchase order (they're separate orders), with one
  // summary toast instead of N.
  const [poExpanded, setPoExpanded] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const confirmAllReceipts = async () => {
    setConfirmingAll(true);
    let orders = 0;
    let failedLines = 0;
    let failedGroups = 0;
    let lastErr: string | null = null;
    const committedIds: string[] = [];
    try {
      for (const g of receiptGroups) {
        try {
          const r = await api.confirmReceiptGroup(activeSlug, g.groupId);
          if (r.order_id) orders += 1;
          // The server reports per-line failures IN the response; filtering
          // them out silently made "4-line receipt, 2 failed" read as a clean
          // "2 items" success (2026-08-25 audit).
          for (const c of r.confirmed) {
            if (!c.error && c.itemId) committedIds.push(c.itemId);
            else if (c.error) failedLines++;
          }
        } catch (e) {
          failedGroups++;
          lastErr = e instanceof ApiError ? e.message : String(e);
        }
      }
      await qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      await qc.invalidateQueries({ queryKey: ["scan-inbox-resolved", activeSlug] });
      const itemsN = committedIds.length;
      if (itemsN === 0 && (failedGroups > 0 || failedLines > 0)) {
        // Nothing landed. The old message here blamed a missing Purchases
        // module for what was an API failure, over an Undo that undid nothing.
        toast.error(`Couldn't confirm the receipts${lastErr ? ` - ${lastErr}` : ""}`);
        return;
      }
      const trouble =
        failedLines || failedGroups
          ? ` · ${failedLines + failedGroups} ${failedLines ? "line" : "receipt"}${failedLines + failedGroups === 1 ? "" : "s"} failed and stayed in the inbox`
          : "";
      // Undo the WHOLE bulk commit — one tap sends every line from every receipt
      // back to the inbox, unsorted, if "Confirm all" was premature (reported 2026-07-24).
      toast.action(
        (orders
          ? `Created ${orders} purchase order${orders === 1 ? "" : "s"} (${itemsN} item${itemsN === 1 ? "" : "s"})`
          : `Confirmed ${itemsN} item${itemsN === 1 ? "" : "s"} (enable Purchases to group them into orders)`) + trouble,
        {
          actionLabel: "Undo all",
          duration: 10000,
          onAction: () => void undoCommittedIds(committedIds),
        },
      );
    } finally {
      setConfirmingAll(false);
    }
  };

  /** An icon-sized header control. */
  const headerIcon =
    "inline-flex items-center justify-center rounded border border-line dark:border-slate-700 text-content hover:bg-subtle dark:hover:bg-slate-800/70 p-1.5 transition shrink-0";

  // ── the one intake box ────────────────────────────────────────────────────
  const [omniOpen, setOmniOpen] = useState(false);
  const omniRef = useRef<HTMLInputElement>(null);
  const submitOmni = async () => {
    const intent = classifyOmni(searchQ);
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
  const lastTakeRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const takeFiles = (files: File[]) => {
    const intent = classifyFiles(files);
    if (!intent) return;
    // Name + size + mtime identifies a file well enough for a window this
    // short, and a second later the same file is a deliberate re-add.
    const key = files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join("|");
    const now = Date.now();
    if (key === lastTakeRef.current.key && now - lastTakeRef.current.at < 1000) return;
    lastTakeRef.current = { key, at: now };
    if (intent.kind === "photos") void uploadPhotos(intent.files);
    else void uploadReceipt(intent.file);
  };
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
  // DISJOINT on purpose: `isReadyToFile` (a name + a destination) and
  // `needsReview` (no name / low confidence / rate-limited) genuinely overlap in
  // the data - a named item at 0.4 confidence is both - and showing 5 ready + 3
  // review over 8 items when two are counted twice is a lie the eye can check.
  // Review wins, matching how the page tells you to work: bulk-confirm the
  // confident ones, then focus the rest.
  const confidentCount = items.filter((i) => isReadyToFile(i) && !needsReview(i)).length;

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
  // Phase 2: the put-away walk. `walkPlan` set = walk sheet open. The latest
  // stored plan also powers a "resume walk" chip after a reload mid-walk.
  const [walkPlan, setWalkPlan] = useState<OrganizeStoredPlan | null>(null);
  const latestPlanQ = useQuery({
    queryKey: ["organize-plan-latest", activeSlug],
    queryFn: () => api.getLatestOrganizePlan(activeSlug),
    staleTime: 30_000,
  });
  const resumablePlan = (() => {
    const p = latestPlanQ.data?.plan;
    if (!p || p.applied_group_ids.length === 0) return null;
    const placed = new Set(p.walk_state.placed_item_ids ?? []);
    const appliedSet = new Set(p.applied_group_ids);
    const remaining = p.groups
      .filter((g) => appliedSet.has(g.id) && g.destination.kind === "existing")
      .flatMap((g) => g.item_ids)
      .filter((id) => !placed.has(id));
    return remaining.length > 0 ? { plan: p, remaining: remaining.length } : null;
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
    try {
      // Pin the plan the user just applied when we know its id — a warm re-plan
      // fired after Accept all is newer and empty, so "latest" alone would miss.
      const r = await api.getLatestOrganizePlan(activeSlug, planId);
      if (r.plan && r.plan.applied_group_ids.length > 0) setWalkPlan(r.plan);
      else toast.error("Nothing applied to walk yet - accept a group first.");
    } catch {
      toast.error("Couldn't load the plan for the walk.");
    }
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
  // Gallery view's focus modal: which item is open as a full triage card.
  const [galleryFocusId, setGalleryFocusId] = useState<string | null>(null);
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
      toast.success(`Re-parsed: ${r.receipt.item_count} item${r.receipt.item_count === 1 ? "" : "s"}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
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
      if (!it || !it.suggested_name) {
        skipped++;
        continue;
      }
      try {
        await api.confirmScanItem(activeSlug, id, {
          target_module: entry.module,
          target_kind: entry.kind.includes(":") ? entry.kind.split(":")[1] : entry.kind,
          instance: entry.instance ?? undefined,
          name: it.suggested_name,
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
      const better = betterDestination(it.suggested_name ?? "", cand?.kind ?? null, tables, cand?.module ?? null);
      if (!better) continue;
      const entry = (menu ?? []).find((m) => (m.instance ?? m.module) === better.instance_name);
      if (!entry) continue;
      const label = better.display_name ?? better.instance_name;
      const cur = misrouted.get(label) ?? { label, entry, ids: [], names: [] };
      cur.ids.push(id);
      cur.names.push(it.suggested_name ?? "one scan");
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
    if (skipped) parts.push(`${skipped} need a manual look`);
    if (failed) parts.push(`${failed} failed${lastErr ? ` - ${lastErr}` : ""}`);
    if (ok === 0 && failed > 0) toast.error(parts.join(" · "));
    else if (failed > 0) toast.info(parts.join(" · "));
    else toast.success(parts.join(" · "));
    return { ok, skipped, failed };
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
            file's TYPE routes it, so nobody has to answer "which kind of
            upload" before they have even chosen a file. A PDF or CSV is only
            ever a receipt, so it goes to the parser; images go to the photo
            pipeline, which is the common case by a wide margin. Anything that
            is neither - an export to import - stays an explicit menu item,
            grouped with Export, because it is not a pic or a receipt and
            pretending otherwise would make this control mean nothing. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf,.csv,text/csv"
          multiple
          className="hidden"
          onChange={(e) => {
            const fs = Array.from(e.target.files ?? []);
            if (!fs.length) return;
            const isReceiptDoc = (f: File) =>
              f.type === "application/pdf" || /\.(pdf|csv)$/i.test(f.name) || f.type === "text/csv";
            const docs = fs.filter(isReceiptDoc);
            const pics = fs.filter((f) => !isReceiptDoc(f));
            // A receipt document is parsed one at a time (each is its own
            // order); photos come in together as one session.
            for (const d of docs) void uploadReceipt(d);
            if (pics.length) void uploadPhotos(pics);
          }}
        />
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

        {/* Everything that is real but rare. Grouped by what it acts ON, so
            "this inbox" and "elsewhere in the workspace" cannot be confused. */}
        <HeaderMenu
          width={264}
          align="right"
          trigger={({ toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-label="More inbox actions"
              className={headerIcon}
            >
              <MoreHorizontal size={15} />
            </button>
          )}
        >
          {({ close }) => (
            <>
              {/* Intake first: these were first-class buttons before the header
                  became one row, and on a phone the omni box that now holds
                  them is collapsed behind a magnifier - an icon that reads as
                  Search, not as "upload a photo". Two non-obvious taps is the
                  same as gone (reported 2026-08-10). The paperclip stays for
                  desktop; this is the findable path everywhere. */}
              {/* A FILTER, not a setting: it wore a switch and read as something
                  you were turning on. One quiet line at the very top, the size
                  of a section title (reported 2026-08-10). Phone only - the
                  desktop row still carries the facet itself. */}
              {staleCount > 0 && staleCount < totalPending && (
                <span className="sm:hidden">
                  <MenuFilterLine
                    active={staleOnly}
                    onClick={() => {
                      setReviewOnly(false);
                      setStaleOnly((v) => !v);
                      close();
                    }}
                  >
                    {staleOnly ? `Showing ${staleCount} waiting 2d+ · show all` : `${staleCount} waiting 2d+ · show only these`}
                  </MenuFilterLine>
                </span>
              )}
              <MenuHead>Sort what&rsquo;s here</MenuHead>
              <MenuItem
                icon={<Zap size={14} className="text-amber-500" />}
                label="Live Sort"
                hint="Scan a thing, get told which bin it goes in, confirm, next"
                onClick={() => {
                  close();
                  setLiveSortOpen(true);
                }}
              />
              <MenuSep />
              <MenuHead>This inbox</MenuHead>
              <MenuItem
                icon={<ImageIcon size={14} />}
                label="Fill missing photos"
                hint="Find catalog photos for named items without one"
                onClick={() => {
                  close();
                  void api
                    .backfillScanCatalogPhotos(activeSlug)
                    .then((r) =>
                      toast.success(
                        r.queued
                          ? `Finding photos for ${r.queued} item${r.queued === 1 ? "" : "s"}…`
                          : "Every named item already has a photo",
                      ),
                    )
                    .catch((e) => toast.error(e instanceof ApiError ? e.message : String(e)));
                }}
              />
              {/* The one case the paperclip's type-routing cannot decide. A JPEG
                  is a picture of a thing far more often than it is a receipt,
                  so images go to the photo pipeline and that default is right -
                  but a PHOTOGRAPH of a paper receipt is how most people capture
                  one, and with no way to say so it came back named after
                  whatever the vision pass read off it (reported 2026-08-19: a
                  Walmart receipt landed as "Walmart 16in Cheese Pizza" and went
                  looking for pizza pictures). The parser has always accepted
                  images; only this door was missing. */}
              <MenuItem
                icon={<ReceiptText size={14} />}
                label="Upload a receipt photo"
                hint="A picture of a paper receipt, split into its line items"
                onClick={() => {
                  close();
                  receiptRef.current?.click();
                }}
              />
              <MenuItem
                icon={<Download size={14} />}
                label="Export…"
                hint="Pick items and how photos travel"
                onClick={() => {
                  close();
                  setExportOpen(true);
                }}
              />
              {/* Import belongs NEXT TO export, not with the uploads: it is the
                  other half of the same conversation, and an export file is
                  neither a pic nor a receipt. */}
              <MenuItem
                icon={<Upload size={14} />}
                label="Import an export"
                hint="JSON or CSV, reversible in one click"
                onClick={() => {
                  close();
                  setImportOpen(true);
                }}
              />
              {/* SHOW the address, don't just copy it invisibly. As a plain
                  menu row this said "Email receipts to…" and put something on
                  the clipboard you never saw - the desktop chip reveals the
                  address, and the phone deserves the same fact (reported
                  2026-08-10). */}
              {receiptAddress && (
                <span className="sm:hidden">
                  <ReceiptAddressMenuBlock address={receiptAddress} onCopied={close} />
                </span>
              )}
              <MenuSep />
              <MenuHead>Elsewhere</MenuHead>
              <MenuItem
                icon={<Wand2 size={14} />}
                label="Things with no location"
                hint="Already filed - not in this inbox"
                onClick={() => {
                  close();
                  setOrganizeUnplacedOpen(true);
                }}
              />
              <MenuSep />
              <MenuHead>Capture setup</MenuHead>
              <MenuItem
                icon={<MonitorSmartphone size={14} />}
                label="Drive this screen with scans"
                hint="Scan a bin's QR on your phone; this screen opens it"
                state={scanDrive.on ? "on" : "off"}
                onClick={() => {
                  scanDrive.toggle();
                  close();
                }}
              />
              {/* The two TOGGLES sit together; the one-shot action goes last.
                  Interleaving them made a switch, a button and a switch read as
                  three of the same kind (author, 2026-08-10). */}
              {canSetPhotoRank && photoRank.data && (
                <MenuItem
                  icon={<Sparkles size={14} />}
                  label="Auto-pick photos"
                  hint="AI picks the catalog photo on every scan"
                  state={photoRank.data.enabled ? "on" : "off"}
                  disabled={setPhotoRank.isPending}
                  onClick={() => setPhotoRank.mutate(!photoRank.data.enabled)}
                />
              )}
              <PairPhoneButton asMenuItem onPaired={close} />
            </>
          )}
        </HeaderMenu>
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
      {!list.isLoading && !list.isError && items.length === 0 && (
        <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-8 text-center">
          <ScanLine size={28} className="mx-auto text-faint dark:text-slate-600 mb-2" />
          <div className="text-sm text-muted dark:text-slate-400">
            Nothing pending. Open the camera or add a UPC / photo above.
          </div>
          <div className="text-xs text-faint dark:text-slate-500 mt-1">
            Got a USB or Bluetooth barcode scanner? Just point and scan - it lands
            here automatically, no need to open anything first.
          </div>
        </div>
      )}

      {purchasesEnabled && receiptGroups.length === 1 && receiptGroups[0] && (
        <div className="flex items-center gap-2 rounded-md border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2 text-sm">
          <FileText size={15} className="text-accent shrink-0" />
          <span className="text-content dark:text-mortar-100">
            Receipt{receiptGroups[0].vendor ? ` from ${receiptGroups[0].vendor}` : ""} — {receiptGroups[0].count} item
            {receiptGroups[0].count === 1 ? "" : "s"} pending
          </span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={confirmGroup.isPending}
            onClick={() => confirmGroup.mutate(receiptGroups[0]!.groupId)}
            className="inline-flex items-center rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1 text-sm transition disabled:opacity-50 shrink-0"
          >
            {confirmGroup.isPending ? "Creating…" : "Confirm as purchase order"}
          </button>
        </div>
      )}

      {/* 2+ pending receipts → ONE collapsible banner, not a stack. "Confirm all"
          makes each its own purchase order; expand to confirm one at a time. */}
      {purchasesEnabled && receiptGroups.length > 1 && (
        <div className="rounded-md border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 text-sm">
          <div className="flex items-center gap-2 px-3 py-2">
            <FileText size={15} className="text-accent shrink-0" />
            <button
              type="button"
              onClick={() => setPoExpanded((v) => !v)}
              className="flex items-center gap-1.5 min-w-0 text-left text-content dark:text-mortar-100"
            >
              <ChevronDown size={13} className={`shrink-0 transition ${poExpanded ? "" : "-rotate-90"}`} />
              <span>
                {receiptGroups.length} receipts to confirm as purchase orders
                <span className="text-faint"> · {receiptGroups.reduce((n, g) => n + g.count, 0)} items</span>
              </span>
            </button>
            <div className="flex-1" />
            <button
              type="button"
              disabled={confirmingAll || confirmGroup.isPending}
              onClick={() => void confirmAllReceipts()}
              className="inline-flex items-center rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1 text-sm transition disabled:opacity-50 shrink-0"
            >
              {confirmingAll ? "Creating…" : "Confirm all"}
            </button>
          </div>
          {poExpanded && (
            <div className="border-t border-cobble-300/70 dark:border-cobble-700/70 divide-y divide-cobble-300/50 dark:divide-cobble-700/50">
              {receiptGroups.map((g) => (
                <div key={g.groupId} className="flex items-center gap-2 px-3 py-1.5 pl-8">
                  <span className="text-content dark:text-mortar-100 truncate">
                    Receipt{g.vendor ? ` from ${g.vendor}` : ""} — {g.count} item{g.count === 1 ? "" : "s"}
                  </span>
                  <div className="flex-1" />
                  <button
                    type="button"
                    disabled={confirmGroup.isPending || confirmingAll}
                    onClick={() => confirmGroup.mutate(g.groupId)}
                    className="text-accent hover:underline text-xs disabled:opacity-50 shrink-0"
                  >
                    Confirm
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* The put-away front door on the page itself: a captured backlog is
          Guided Organize's native situation — ONE verb, preview-first
          (put-away.md §5). Live Sort lives where scanning starts instead. */}
      {viewMode !== "plan" &&
        ((scanStatsQ.data?.unfiled ?? 0) > 0 || (scanStatsQ.data?.ready ?? 0) > 0) && (
        // Stack until there's room for a real side-by-side. `flex-wrap` did NOT
        // save this: the text is flex-1 + min-w-0, so it SHRANK to whatever the
        // button left rather than pushing the button to the next line — the
        // sentence wrapped in a half-width column while the button sat in space.
        // Below sm the text gets the full width and the button goes underneath.
        <div
          className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3 rounded-lg border border-cobble-400 dark:border-cobble-600 border-l-4 border-l-cobble-500 dark:border-l-cobble-400 bg-cobble-100 dark:bg-cobble-900 shadow-sm px-3 py-2.5 text-sm"
          data-testid="putaway-strip"
        >
          <span className="min-w-0 flex-1 font-semibold text-content dark:text-mortar-100">
            <span className="mr-1.5">📦</span>
            {[
              (scanStatsQ.data!.unfiled ?? 0) > 0
                ? `${scanStatsQ.data!.unfiled} scanned item${scanStatsQ.data!.unfiled === 1 ? "" : "s"} without a home`
                : null,
              (scanStatsQ.data!.ready ?? 0) > 0 ? `${scanStatsQ.data!.ready} ready to put away` : null,
            ]
              .filter(Boolean)
              .join(", and ")}
            <span className="font-normal text-muted dark:text-slate-400"> · preview first, nothing moves until you confirm</span>
          </span>
          <button
            type="button"
            onClick={() => setViewMode("plan")}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition shrink-0"
          >
            Put them away
          </button>
        </div>
      )}

      {/* A put-away walk left unfinished (reload / tab switch) — offer to resume. */}
      {resumablePlan && !walkPlan && (
        <button
          type="button"
          onClick={() => setWalkPlan(resumablePlan.plan)}
          className="flex items-center gap-2 rounded-lg border border-accent/40 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2 text-sm text-accent hover:bg-cobble-100 dark:hover:bg-cobble-900/50 transition"
        >
          ▶ Resume put-away walk - {resumablePlan.remaining} item
          {resumablePlan.remaining === 1 ? "" : "s"} left to place
        </button>
      )}

      {/* Bulk-triage toolbar — appears once anything is selected. Confirm routes
          each item to its own matchmaker top candidate; discard clears them out. */}
      {(selected.size > 0 || (visibleItems.length > 1 && allVisibleSelected)) && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-accent/40 bg-cobble-100 dark:bg-slate-800 shadow-md px-2.5 py-1.5 text-sm">
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

      {walkPlan && (
        <OrganizeWalkSheet
          slug={activeSlug}
          plan={walkPlan}
          itemsById={new Map(items.map((i) => [i.id, i]))}
          setFileBin={setFileBin}
          onClose={() => {
            setWalkPlan(null);
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
          <div className="inline-flex items-center rounded-full border border-line dark:border-slate-700 p-0.5">
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
        <SeriesBanner slug={activeSlug} items={visibleItems.filter((i) => i.status === "pending")} />
        <SessionThemeBanner slug={activeSlug} pendingCount={visibleItems.filter((i) => i.status === "pending").length} />
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
            const busy = g.items.filter((it) => itemEnriching(it)).length;
            // Pending items with a confident destination + a name — the ones
            // "File all" will commit to their own candidate. Pending items that
            // still need a manual look aren't counted here.
            const readyIds = g.items.filter(isReadyToFile).map((it) => it.id);
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
                <div
                  data-session-header
                  // gap-1.5, not gap-2: eleven gaps across this row, so the
                  // half-step is most of a control's width back.
                  className="flex w-full items-center gap-1.5 overflow-hidden rounded-md bg-mortar-50 dark:bg-slate-800/40 px-2.5 py-1.5 text-left text-xs"
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
                    className="shrink-0 -ml-1 mr-1 h-3.5 w-3.5 accent-cobble-600 cursor-pointer"
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
                    className="shrink-0 text-faint hover:text-accent transition"
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
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setViewSource(g.sourceFileId);
                        }}
                        title="Receipt - open the photo or file its lines were read from"
                        aria-label="Open the original receipt"
                        className="shrink-0 text-faint hover:text-accent transition"
                      >
                        <ReceiptText size={13} />
                      </button>
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
                    <span
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
                      className="font-medium text-content dark:text-mortar-100 truncate min-w-[4rem] sm:min-w-0"
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
                    </span>
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
                            ? `Uploaded ${formatSessionTime(g.latest)}`
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
                  <span className="hidden sm:inline shrink-0 whitespace-nowrap text-faint">
                    {g.items.length} item{g.items.length === 1 ? "" : "s"}
                  </span>
                  {/* Everything after this is an ACTION, and actions sit right. */}
                  <span className="flex-1" />
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
                      className="shrink-0 inline-flex items-center gap-1 text-faint hover:text-accent transition disabled:opacity-50"
                    >
                      <RotateCcw
                        size={11}
                        className={reparse.isPending && reparseBatch === g.batchId ? "animate-spin" : ""}
                      />{" "}
                      <span className="hidden 2xl:inline">Re-parse</span>
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
                  {(isReceiptSession || (!!g.batchId && !!g.trackingNumber)) &&
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
                          <div
                            data-portal-panel
                            role="dialog"
                            aria-label="Parcel status"
                            onClick={(e) => e.stopPropagation()}
                            style={{ top: trackingRect.top, left: trackingRect.left }}
                            className="fixed z-[61] w-64 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2.5 shadow-lg space-y-1.5 text-left"
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
                          </div>,
                          document.body,
                        )}
                      </span>
                    ))}

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
                        sessionLocName && sessionLoc.missing === 0
                          ? "border-line/70 dark:border-slate-700/70 text-content dark:text-mortar-100 hover:border-cobble-400"
                          : "border-amber-400 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-900/25 text-amber-700 dark:text-amber-300 hover:border-amber-500"
                      }`}
                    >
                      <MapPin size={12} />
                      {sessionLoc.mixed ? (
                        <>
                          Mixed<span className="hidden sm:inline">&nbsp;locations</span>
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
                        "Location"
                      )}
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
                            }${fallbackClause}`
                          : `Each goes where the AI matched it${
                              willInstallLabels.length ? `, installing ${willInstallLabels.join(" and ")} on the way` : ""
                            }${fallbackClause}`
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
                                File<span className="hidden sm:inline"> all</span> {readyIds.length}
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
                                File<span className="hidden sm:inline"> all</span> {readyIds.length}
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
                  ) : (
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
                      className="hidden sm:inline shrink-0 text-faint hover:text-accent"
                    >
                      open →
                    </Link>
                  )}
                </div>
                {!collapsed && (
                  <div className="space-y-2">
                    {g.items.map(card)}
                    {/* Merge lives INSIDE the expanded session (reveal-to-use),
                        not on the collapsed header where its old ↓ was mistaken
                        for the accordion and folded sessions by accident. It's a
                        rare re-unify action; every merge is Undo-able via toast. */}
                    {mergeInto && g.batchId && (
                      <div className="pt-0.5">
                        <button
                          type="button"
                          title="Two bursts that are really one job? Fold this session into the previous (older) one. You can undo it."
                          onClick={() =>
                            void mergeBatches.mutateAsync({ from: g.batchId!, into: mergeInto, itemIds: groupIds })
                          }
                          disabled={mergeBatches.isPending}
                          className="text-xs text-faint hover:text-accent disabled:opacity-50"
                        >
                          Merge into the previous session
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
      {/* Gallery focus: the full triage card, pre-expanded, in a modal. */}
      {galleryFocusId &&
        (() => {
          const focus = items.find((i) => i.id === galleryFocusId);
          if (!focus) return null;
          // Triage rip-through: once this item resolves, advance the
          // modal to the NEXT pending item instead of showing a stale card.
          if (focus.status !== "pending") {
            const pending = visibleItems.filter((i) => i.status === "pending" && i.id !== focus.id);
            const next = pending[0];
            if (next) setTimeout(() => setGalleryFocusId(next.id), 0);
            else setTimeout(() => setGalleryFocusId(null), 0);
            return null;
          }
          return (
            <Modal open onClose={() => setGalleryFocusId(null)} title={focus.suggested_name ?? "Item"} size="lg">
              <InboxCard
                item={focus}
                pageTarget={target}
                menu={menu}
                sessionCategoryLabel={sessionCategoryByItem.get(focus.id) ?? null}
                hasLocations={hasLocations}
                defaultExpanded
                onArmBin={setFileBin}
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
                      {d.suggested_name ?? d.barcode_text ?? "Unknown scan"}
                    </div>
                    {d.barcode_text && d.suggested_name && (
                      <div className="text-[10px] font-mono text-faint truncate">{d.barcode_text}</div>
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
                          <div className="text-sm text-muted truncate">{d.suggested_name ?? d.barcode_text ?? "Unknown scan"}</div>
                          <CommittedDestination item={d} tables={destinationTables} />
                        </div>
                        <button
                          type="button"
                          onClick={() => unconfirm.mutate(d.id)}
                          disabled={unconfirm.isPending || sendingBackAll === grp.key}
                          className="shrink-0 text-xs text-faint hover:text-content disabled:opacity-50"
                        >
                          Send back
                        </button>
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
                          {grp.items[0].suggested_name ?? grp.items[0].barcode_text ?? "Unknown scan"}
                        </div>
                        <CommittedDestination item={grp.items[0]} tables={destinationTables} />
                      </div>
                      <button
                        type="button"
                        onClick={() => unconfirm.mutate(grp.items[0]!.id)}
                        disabled={unconfirm.isPending}
                        className="shrink-0 inline-flex items-center gap-1 text-xs rounded border border-line px-2 py-1 text-muted hover:text-content disabled:opacity-50"
                      >
                        <RotateCcw size={12} /> Send back
                      </button>
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
          items={items.map((i) => ({ id: i.id, name: i.suggested_name ?? "" }))}
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
function MakeBinSheet({
  item,
  onClose,
  onArmBin,
}: {
  item: ScanInboxItem;
  onClose: () => void;
  onArmBin?: (locId: string) => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const locs = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const suggested = useMemo(
    () => nextBinName((locs.data?.items ?? []).map((l) => l.name)),
    [locs.data],
  );
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string | null>(item.target_location_id ?? null);
  // Seed the name once the locations land — not on every refetch, or typing races.
  const seeded = useRef(false);
  useEffect(() => {
    if (!seeded.current && locs.data) {
      setName(suggested);
      seeded.current = true;
    }
  }, [locs.data, suggested]);
  const create = useMutation({
    mutationFn: async (arm: boolean) => {
      const loc = await api.createLocation(activeSlug, {
        name: name.trim(),
        kind: "container",
        ...(parent ? { parent_id: parent } : {}),
      });
      await api.confirmScanIntoLocation(activeSlug, item.id, loc.id);
      return { loc, arm };
    },
    onSuccess: ({ loc, arm }) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["core-locations", activeSlug] });
      if (arm) onArmBin?.(loc.id);
      toast.success(
        arm ? `${loc.name} created - new scans file into it` : `${loc.name} created`,
      );
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const busy = create.isPending;
  return (
    <Modal open onClose={onClose} title="Turn this into a bin" size="sm">
      <div className="space-y-3">
        <p className="text-xs text-muted dark:text-slate-400">
          Creates a location from this scan in one step: the product photo, barcode
          and brand land on the bin&rsquo;s record and the inbox item is done. The
          bin&rsquo;s name is yours; the product identity rides underneath.
        </p>
        <label className="block">
          <span className="text-xs font-medium text-content dark:text-mortar-100">Bin name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !busy) create.mutate(true);
            }}
            className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-800 px-2 py-1.5 text-sm text-content dark:text-mortar-100"
          />
        </label>
        <div>
          <div className="text-xs font-medium text-content dark:text-mortar-100 mb-1">
            Where does the bin live? <span className="font-normal text-faint">(optional)</span>
          </div>
          <div className="max-h-44 overflow-y-auto">
            <LocationChipPicker value={parent} onChange={setParent} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => create.mutate(false)}
            className="rounded border border-line dark:border-slate-600 px-3 py-1.5 text-sm text-muted dark:text-slate-300 hover:bg-mortar-50 dark:hover:bg-slate-800 transition disabled:opacity-50"
          >
            Create bin
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => create.mutate(true)}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create & scan into it"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function InboxCard({
  item,
  pageTarget,
  menu,
  sessionCategoryLabel,
  hasLocations,
  selected,
  onToggleSelect,
  defaultExpanded,
  planContext,
  onCollapse,
  onArmBin,
}: {
  item: ScanInboxItem;
  pageTarget: ScanTarget | null;
  menu: ScanMenuEntry[] | null;
  /** The label this item's SESSION agreed on, so sibling cards cannot show one
   *  category two ways. Null when the session settled on nothing. */
  sessionCategoryLabel?: string | null;
  hasLocations: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** Open pre-expanded (the gallery view's focus modal). */
  defaultExpanded?: boolean;
  /** Rendered INSIDE an organize plan's accordion: the card is an identity
   *  FIXER there (name, photo, AI hint/rerun), never a commit surface —
   *  confirming into a table mid-plan yanks the item out of the plan (the
   *  trap the author hit). Hides the confirm form, table chips, and
   *  discard; the accordion owns collapse. */
  planContext?: boolean;
  /** In planContext, fully close the accordion row (the card is always expanded
   *  there, so the ▲ chevron delegates here instead of toggling its own body,
   *  which would leave the outer "Done fixing" box behind). */
  onCollapse?: () => void;
  /** "Turn into a bin" armed the new bin as the standing file-bin — the page
   *  owns that state (localStorage + header chip), so it passes the setter. */
  onArmBin?: (locId: string) => void;
}) {
  const { activeSlug, activeOrg } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();

  // Locations, only to name the filing bin on the card. Same query key as the
  // page's list, so this reads the shared react-query cache — no extra fetch.
  const cardLocs = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug && hasLocations,
    staleTime: 60_000,
  });

  // The expansion's confirm context: which table/instance the form commits
  // into + the matchmaker's pre-filled fields. Keyed into ConfirmForm so
  // switching chips remounts (and so re-seeds) the form.
  const [expanded, setExpanded] = useState(false);
  // The source-data box's disclosure — OPEN by default (provenance + the routed
  // fields at a glance); tap to collapse.
  const [aiOpen, setAiOpen] = useState(true);
  const [formCtx, setFormCtx] = useState<{
    selKey: string | null;
    prefill: Record<string, unknown>;
  }>({
    selKey: pageTarget ? entryKey(pageTarget.module, pageTarget.instance) : null,
    prefill: {},
  });
  // The commit form is SUMMONED, not ambient (scan-inbox-ux-review.md F1): a
  // plain expand shows the triage surface only, and the form renders once a
  // destination is picked — a chip tap, the "Add to …" summon row, or the
  // gallery-focus modal. Rendering every field of the top table on every
  // expand is what buried a tote under six empty vehicle boxes.
  const [formOpen, setFormOpen] = useState(false);
  // Collapse ENDS editing, whichever control collapsed the card. The form's
  // chips replace the header row's read-only chips while it is open, but the
  // form itself lives in the expanded body — so a card collapsed mid-edit kept
  // formOpen and showed NO chips at all: the read-only ones hidden, the
  // editable ones unmounted. The edits were already lost on collapse (the form
  // unmounts with the body); this makes the state say so.
  useEffect(() => {
    if (!expanded) setFormOpen(false);
  }, [expanded]);

  function expandOnly() {
    setExpanded(true);
  }

  function openForm(cand?: ScanCandidate) {
    // No explicit chip and no ?into= target → default to the matchmaker's
    // TOP candidate, fields pre-filled. Expanding a card should land on the
    // AI's best read, not a blank form (the chip tap is a shortcut, not a
    // requirement).
    // An unidentified item ("Unknown Item") shouldn't auto-route anywhere —
    // leave the target unselected so the user picks, rather than pre-filling
    // "Inventory part" for a thing we couldn't identify.
    const pick =
      cand ?? (pageTarget || isUnidentified(item.suggested_name) ? null : (topCand ?? null));
    setFormCtx(
      pick
        ? { selKey: entryKey(pick.module, pick.instance), prefill: pick.fields }
        : {
            selKey: pageTarget ? entryKey(pageTarget.module, pageTarget.instance) : null,
            prefill: {},
          },
    );
    setFormOpen(true);
    setExpanded(true);
  }

  // Gallery focus modal opens the card pre-expanded (one tap to triage);
  // plan accordions expand WITHOUT arming the (hidden) confirm form.
  useEffect(() => {
    if (defaultExpanded) {
      if (planContext) setExpanded(true);
      else openForm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The matchmaker is SERVER-OWNED: it runs once at intake (detached) and
  // inline during a rerun. The web never auto-triggers it — a page load
  // costs zero model runs. While the server hasn't stamped matched_at yet,
  // the card shows a passive "AI is reading…" pulse that the 8s list poll
  // resolves on its own.
  // Drop candidates that would file an EMPTY record — a table the matchmaker
  // thought fit but extracted 0 fields for (e.g. a bare "Home Inventory" chip
  // sitting next to "Bookshelf · 4 fields"). It reads like an equal option but
  // fills nothing. Always keep the top match though (index 0), so a weak-but-
  // best guess still offers somewhere to go; the full table picker in the
  // confirm form still lists every table if the user wants one of the dropped.
  const candidates = dedupeCandidates(item.suggested_candidates ?? [])
    .filter((c, i) => i === 0 || Object.keys(c.fields ?? {}).length > 0)
    .slice(0, 3);
  const topCand = candidates[0] ?? null;
  // The destination is now CHOSEN, not just the top match: the split chip
  // carries a picker, so the other candidates are options in it rather than
  // chips of their own. Everything downstream reads `dest`, so the gates and
  // the one-tap commit follow the choice instead of the ranking.
  const [destKey, setDestKey] = useState<string | null>(null);
  const [destOpen, setDestOpen] = useState(false);
  // The picker's dismiss layer covers the whole app, so floating chrome (the
  // Live pill, the feedback bubble) has to yield to it like any overlay.
  useOverlayOpenFlag(destOpen);
  // The menu PORTALS to body, positioned from the pill's rect. Anchored in
  // place it was clipped by the card's own bounds - it opened below correctly
  // and simply could not be seen past the second option.
  const destBtnRef = useRef<HTMLButtonElement | null>(null);
  const [destRect, setDestRect] = useState<{ top: number; left: number } | null>(null);
  const openDest = () => {
    const r = destBtnRef.current?.getBoundingClientRect();
    // Clamped to the viewport for the same reason as the tracking panel: a
    // pill near the right edge put the menu mostly off-screen on a phone.
    if (r) setDestRect({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 288 - 8)) });
    setDestOpen(true);
  };
  const closeDest = () => {
    setDestOpen(false);
    // Hand focus back to the pill, so Escape doesn't dump keyboard users at
    // the document root. The native <select> this replaced did all of this
    // for free — everything here is paying that debt back.
    destBtnRef.current?.focus();
  };
  // The menu's position is measured ONCE at open, so a page that scrolls
  // underneath would leave it floating detached from the pill. Close instead
  // of chasing it: a scroll mid-pick means attention moved elsewhere.
  useEffect(() => {
    if (!destOpen) return;
    const onScroll = () => setDestOpen(false);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [destOpen]);
  // EVERY table, not just the matchmaker's guesses. The old "add somewhere
  // else…" existed because the chips only offered what the AI proposed; with a
  // picker there is no reason to hide the rest. Candidates keep their extracted
  // fields and lead the list; the remaining tables follow with none.
  const destOptions = (() => {
    const base = withRoutedInstances(menu && menu.length > 0 ? menu : FALLBACK_MENU, candidates);
    const seen = new Set(candidates.map((c) => entryKey(c.module, c.instance)));
    const rest = base
      .filter((m) => !seen.has(entryKey(m.module, m.instance)))
      // Same shape as a candidate, minus the things only the matchmaker knows
      // (no extracted fields, no basis, no bundle to install).
      .map(
        (m) =>
          ({
            ...m,
            instance: m.instance ?? null,
            fields: {} as Record<string, string>,
            // A table you picked yourself carries no matchmaker verdict: no
            // extracted name, no confidence. Explicit rather than cast away.
            name: item.suggested_name ?? "",
            confidence: 0,
          }) as (typeof candidates)[number],
      );
    return [...candidates, ...rest];
  })();
  const dest =
    destOptions.find((c) => entryKey(c.module, c.instance) === destKey) ?? topCand ?? destOptions[0] ?? null;

  // A ROUTE CAN GO STALE WHILE IT SITS IN THE INBOX.
  //
  // The matchmaker answers once, against the workspace as it was. Scan a box of
  // tea, install a Tea table a week later, and the stored answer still says
  // plain Inventory - correct when it was written, wrong by the time anybody
  // presses File. That is how five teas and three spice blends ended up in
  // Inventory with Spices and Tea sitting empty beside them.
  //
  // Computed HERE, at render, against the LIVE menu - so unlike a stored
  // recomputation it cannot itself go stale. And it never changes the
  // destination on its own: a route somebody can see and ignore costs a glance,
  // one that moves under them costs their trust.
  const staleHint = (() => {
    if (!dest || item.status !== "pending") return null;
    const tables = (menu ?? []).map((m) => ({
      instance_name: m.instance ?? m.module,
      display_name: m.label,
      module_name: m.module,
      // The terms the table declares for itself. Without these the nudge can
      // only find a table whose NAME an item says, so Groceries could never be
      // suggested by anything - no food is called a grocery. That is the same
      // reason the routing keywords exist in the first place.
      keywords: m.scan_keywords ?? [],
    }));
    const better = betterDestination(item.suggested_name ?? "", dest.kind, tables, dest.module);
    if (!better) return null;
    const entry = (menu ?? []).find((m) => (m.instance ?? m.module) === better.instance_name);
    return entry ? { entry, label: better.display_name ?? better.instance_name } : null;
  })();
  // Re-arm the OPEN form when a re-run lands a new answer. `formCtx` (which drives
  // ADD TO + the pre-filled fields) is only set by openForm() on a CLICK, so a
  // re-run updated the header chips and the Source panel while the form below kept
  // the previous run's route + category until the user closed and reopened the
  // card (reported 2026-07-17: re-identified a miter-saw misread as a tool tote, but
  // ADD TO still said Machines / Power tool). A re-run is an explicit "identify
  // this again", so adopting its result into the open form is what's expected.
  // Keyed on the top candidate's signature (route + fields), the same shape the
  // ConfirmForm key already remounts on — so the props it remounts with stop being
  // stale. Only when the form is actually on screen; never auto-expands a card.
  const answerSig = topCand ? `${topCand.module}:${topCand.instance ?? ""}|${JSON.stringify(topCand.fields)}` : "none";
  const lastAnswerSig = useRef(answerSig);
  useEffect(() => {
    if (lastAnswerSig.current === answerSig) return;
    lastAnswerSig.current = answerSig;
    // Only re-arm a form that is actually on screen — a re-run must not summon
    // the form onto a card the user expanded for triage only.
    if (formOpen && expanded && !planContext) openForm(topCand ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerSig]);
  // Stuck-nameless: enrichment finished (ai_suggested_at) but produced no name
  // and no candidates — a bare photo that couldn't be auto-identified. Offer the
  // manual "name it" entry instead of an endless "AI is reading…" pulse.
  // Reading a receipt is WORK, not failure. Without this the row - a photo,
  // no name, enrichment finished - reads as "couldn't identify" for the
  // seconds it takes to become line items (reported 2026-08-31).
  const readingReceipt =
    item.status === "pending" &&
    !!(item.suggested_metadata as { reading_receipt?: boolean } | null)?.reading_receipt;
  const needsName =
    item.status === "pending" &&
    !item.suggested_name &&
    !!item.ai_suggested_at &&
    !readingReceipt &&
    candidates.length === 0;
  // How long ago enrichment finished — the matchmaker runs detached AFTER that
  // and stamps matched_at when done. If matched_at never lands (the match threw
  // before stamping), GIVE UP the "finding the best table…" pulse after a few
  // minutes instead of spinning forever — show the resolved name + let the user
  // route/re-run by hand. (The 8s list poll re-renders the card, so this flips on
  // its own.) Belt-and-braces with the backend now stamping matched_at on failure.
  const matchAgeMs = item.ai_suggested_at ? Date.now() - new Date(item.ai_suggested_at).getTime() : Infinity;
  const serverMatching =
    item.status === "pending" &&
    !!(item.suggested_name || item.ai_suggested_at) &&
    candidates.length === 0 &&
    !(item.suggested_metadata as { matched_at?: string } | null)?.matched_at &&
    !needsName &&
    matchAgeMs < 180_000;
  // The post-match tail (matched_at → finalized_at: location + a cover re-fetched
  // for a renamed item) used to show a quiet "finishing…" here, on the theory that
  // it was a ~1-min gap where the card looked settled while still mutating. The
  // prod numbers say otherwise — mean 0.19s, p95 0.72s, max 0.88s over every
  // stamped item, none above 2s — so there is no gap to narrate. See itemEnriching.
  // Rate-limited: rapid scanning exhausted the go-upc gate / upcitemdb burst, so
  // the resolver was throttled. The row is tagged + left unfinished (no name, no
  // ai_suggested_at). Show a distinct "retrying" state — NOT a passive "awaiting
  // lookup" that reads like a miss — and the list auto-retries it (paced).
  const rateLimited =
    item.status === "pending" &&
    !item.suggested_name &&
    !item.ai_suggested_at &&
    !!(item.suggested_metadata as { rate_limited?: boolean } | null)?.rate_limited;
  // The "retrying…" pulse. The flag itself is now the whole answer: the server's
  // retry worker clears it when the budget is spent, so this stops pulsing
  // because the row stopped saying it was retrying - not because a browser tab
  // counted to two.
  const rlActive = rateLimited;
  // Couldn't auto-identify → offer manual naming. ONE condition now: enrichment
  // finished and left no name. A spent rate-limit arrives here too, because the
  // retry worker stamps ai_suggested_at when it gives up, which is what
  // needsName reads.
  const cantIdentify = needsName;
  // The matchmaker THREW for this item: the backend stamps match_failed (+
  // matched_at, so the pulse stops) — but the row then read as SETTLED with a
  // name, zero candidates, and no error anywhere, while File-all silently
  // skipped it. Surface the failure with a one-tap retry (rerun-ai clears the
  // marker server-side).
  const matchFailed =
    item.status === "pending" &&
    !!(item.suggested_metadata as { match_failed?: boolean } | null)?.match_failed;
  // A scan with no photo (just a barcode) must not say "this photo".
  const idNoun = item.barcode_text || item.source_kind === "barcode" ? "barcode" : "photo";
  // "Awaiting lookup…" only while genuinely fresh — nothing has come back yet.
  // Once the matchmaker has run, a tentative table exists, or we're rate-limited,
  // the lookup has SETTLED; an unnamed row then prompts to name, not "awaiting".
  const awaitingFresh =
    !item.suggested_name && !item.ai_suggested_at && candidates.length === 0 && !rateLimited;
  // Low-trust hit: a short/ambiguous barcode the catalogs may have mis-matched
  // (set in enrich.ts). Surface a ⚠ note + an obvious one-tap corrector so a
  // wrong match is easy to catch and fix — the fix feeds the shared Barcode
  // Intelligence DB and improves the next scan of this UPC everywhere.
  const lowTrust = !!(item.suggested_metadata as { low_trust?: boolean } | null)?.low_trust;
  // Amber warning line vs the Source data box - one or the other, never both,
  // and never a function of whether the card happens to be open.
  const notesPlacement = scanNotesPlacement({ notes: item.ai_notes, rateLimited, lowTrust });
  const barcodeIdentified = !!item.barcode_text && !!item.suggested_name;
  // "I said I would photograph this." A person set it, so an AI re-run must
  // not clear it (see IDENTIFY_OWNED_KEYS in core-scan metadata.ts).
  const photoWanted =
    (item.suggested_metadata as { photo_wanted?: boolean } | null)?.photo_wanted === true;
  // core-scan's OWN identifier for the receipt this item came off. Handed to
  // contributed panels as a hint; what any of them make of it is theirs.
  const receiptGroupId =
    (item.suggested_metadata as { receipt_group_id?: string } | null)?.receipt_group_id ?? null;
  const [correcting, setCorrecting] = useState(false);
  // The photo cross-check flagged the barcode→name as wrong AND read the real
  // product off the label. Offer it as a one-tap fix: applying it renames the
  // item, and a rename reports the correction to the Barcode Intelligence DB.
  const photoMismatch = (
    item.suggested_metadata as { photo_mismatch?: { correct_name?: string; reason?: string } } | null
  )?.photo_mismatch;
  const photoSuggestedName = photoMismatch?.correct_name?.trim() || "";

  const discard = useMutation({
    mutationFn: () => api.discardScanItem(activeSlug, item.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-inbox-discarded", activeSlug] });
      // Undo inline — a mis-click shouldn't send you hunting in Recently deleted.
      // Name the item so stacked toasts are distinguishable; auto-dismiss (7s) so
      // they don't pile up sticky.
      const label =
        item.suggested_name?.trim() ||
        (item.barcode_text ? `barcode ${item.barcode_text}` : "item");
      toast.action(`Removed ${label}`, {
        actionLabel: "Undo",
        duration: 7000,
        onAction: async () => {
          try {
            await api.restoreScanItem(activeSlug, item.id);
          } catch (e) {
            // An unhandled rejection here dismissed the toast, kept the item
            // deleted, and let the user believe it came back.
            toast.error(e instanceof ApiError ? e.message : "Couldn't bring it back - it is in Recently deleted");
            return;
          }
          void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
          void qc.invalidateQueries({ queryKey: ["scan-inbox-discarded", activeSlug] });
        },
      });
    },
    // The only mutation in this file that had no onError: a failed discard
    // showed nothing, the card stayed put, and the user tapped again.
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Apply the photo cross-check's identification as the name (one tap). The
  // rename PATCH reports the correction to the Barcode Intelligence DB, so the
  // wrong barcode→name is fixed for the next scan everywhere.
  const applyPhotoName = useMutation({
    mutationFn: () => api.updateScanItem(activeSlug, item.id, { name: photoSuggestedName }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success(`Renamed to "${photoSuggestedName}" — fix reported to the barcode DB.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Adjust the pending item's quantity in place (e.g. an over-counted dedup) —
  // a PATCH that keeps it in the inbox; no commit.
  const qtyPatch = useMutation({
    mutationFn: (q: number) => api.updateScanItem(activeSlug, item.id, { quantity: q }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // A barcode rerun resolves inline server-side (so its toast can assert the
  // result). A PHOTO rerun is fire-and-forget now: the vision+match runs detached
  // so the request can't be held past Cloudflare's ~100s timeout (which 524s).
  // For photos, track a local "reading" pulse from the moment we fire until the
  // server stamps a fresh ai_suggested_at — the 8s list poll surfaces it — so the
  // card keeps a live "AI reading…" state instead of snapping back to its old one.
  const isPhotoItem = !item.barcode_text && !!item.image_file_id;
  const [reading, setReading] = useState(false);
  const readingSnapshot = useRef<string | null>(null);
  // One-tap confirm from the collapsed row — commit into the AI's top candidate
  // without opening the accordion (mirrors the form's confirm path). Ready only
  // when we have a routed candidate + a name (same guard as bulk-confirm).
  // The top match can be a bundle this workspace hasn't installed (a scanned VIN
  // → "Vehicles"). Surface the install right on the CLOSED card — most people
  // won't open the accordion. Owner/admin only (install changes composition).
  // Editor included: the server-side enable path (module enable behind the
  // confirm) allows editor too, and gating the UI stricter than the API just
  // hands editors a raw 409 instead of the install flow (2026-08-25 audit).
  const canInstallBundle =
    activeOrg?.role === "owner" || activeOrg?.role === "admin" || activeOrg?.role === "editor";
  const topBundle = canInstallBundle && dest?.bundle_external_id ? dest : null;
  // Ready to one-tap confirm from the collapsed card. A not-installed-bundle top
  // match is only "ready" when the user can install it (else the green check
  // would try to file into a table that doesn't exist).
  // "We already have one of these" — resolved server-side at match time and
  // stamped on the row, so the CLOSED card knows without a per-card round trip.
  // One-tap Add CREATES an entity; offering it when the workspace already tracks
  // the thing is how you end up with a second Honda Civic. So the green Add gives
  // way to a chip that opens the card, where the merge banner lives.
  const trackedMatch = (
    (item.suggested_metadata as Record<string, unknown> | null) ?? {}
  ).tracked_match as { title?: string } | null | undefined;
  const alreadyTracked = !!trackedMatch?.title;
  // A keyword-basis route is a no-AI guess held up only by corroborating
  // keyword hits — the tier that filed a storage tote into Vehicles. It renders
  // tentative (outline + "?") and gets no one-tap Add; isReadyToFile applies
  // the same bar to File all, so the card and the bulk sweep agree.
  const tentativeRoute = dest?.basis === "keywords";
  const cardAiStatus = useAiStatus();
  /** No identifier reachable at all - so a nameless photo is unread, not misread. */
  const identifyOff = !!cardAiStatus && !cardAiStatus.identify_available;
  // The matchmaker fell to the keyword floor although this workspace HAS
  // working AI — the model call failed and the code silently downgraded. Say
  // so, with a one-tap retry, instead of letting a lexical guess sit there
  // looking settled (scan-inbox-ux-review.md F4).
  const aiDowngraded =
    !!topCand?.heuristic && !!cardAiStatus?.available && item.status === "pending";
  const quickConfirmReady =
    !!dest &&
    !!item.suggested_name &&
    !alreadyTracked &&
    !tentativeRoute &&
    (!dest.bundle_external_id || !!topBundle);
  const quickConfirm = useMutation({
    mutationFn: async () => {
      if (!dest || !item.suggested_name) throw new Error("not ready to confirm");
      // Install the bundle first (no item_ids = install-only) so its table
      // exists, then file into it — the same install-then-add the form's Confirm
      // runs, but with the scan's values as-is (open the card to edit them).
      let installed: BundleInstallSummary | null = null;
      const destInstance = await resolveInstanceForFiling(
        activeSlug,
        dest.bundle_external_id,
        dest.instance,
        (sum) => {
          installed = sum;
        },
      );
      const meta = (item.suggested_metadata as Record<string, unknown> | null) ?? {};
      const serial = String((meta as { serial_number?: unknown }).serial_number ?? "");
      const extras = {
        ...(item.suggested_manufacturer ? { manufacturer: item.suggested_manufacturer } : {}),
        ...(serial ? { serial_number: serial } : {}),
        ...(dest.fields && Object.keys(dest.fields).length ? { metadata: dest.fields } : {}),
      };
      await api.confirmScanItem(activeSlug, item.id, {
        target_module: dest.module,
        target_kind: baseKind(dest.module),
        instance: destInstance,
        name: item.suggested_name,
        quantity: item.quantity ?? dest.quantity ?? undefined,
        location_id: item.target_location_id ?? undefined,
        extras: Object.keys(extras).length ? extras : undefined,
      });
      return { installed: installed as BundleInstallSummary | null };
    },
    onSuccess: ({ installed }) => {
      // ONE toast. The install summary and "added <thing>" are the same event,
      // and two toasts for one tap is noise - which is what shipping the
      // summary as its own toast produced (seen on staging, 2026-08-22).
      const changed = installed ? installToastLine(installed) : null;
      toast.success(
        changed
          ? `Added ${item.suggested_name}. ${changed}`
          : topCand?.bundle_external_id
            ? `Installed ${topCand.label}. Added ${item.suggested_name}.`
            : `Added ${item.suggested_name}`,
      );
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      if (topCand?.bundle_external_id) {
        void qc.invalidateQueries({ queryKey: ["scan-menu", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["org-modules", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["instances", activeSlug] });
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // Put back what the last re-run overwrote (the row snapshots it before running).
  const undoRerun = useMutation({
    mutationFn: () => api.scanUndoRerun(activeSlug, item.id),
    onSuccess: (it) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success(it.suggested_name ? `Back to “${it.suggested_name}”` : "Previous lookup restored");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const rerun = useMutation({
    mutationFn: (vars?: {
      hint?: string;
      wrong?: boolean;
      enrich?: boolean;
      noAi?: boolean;
      /** Corrected barcode - lands on barcode_text, then the lookup re-runs. */
      barcode?: string;
      /** Re-identify from THIS photo (an extra photo the user just added). */
      imageFileId?: string;
    }) =>
      api.rerunScanAi(activeSlug, item.id, {
        hint: vars?.hint,
        wrong: vars?.wrong,
        enrich: vars?.enrich,
        noAi: vars?.noAi,
        barcode: vars?.barcode,
        imageFileId: vars?.imageFileId,
      }),
    onMutate: (vars) => {
      if (isPhotoItem || vars?.imageFileId) {
        readingSnapshot.current = item.ai_suggested_at ?? null;
        setReading(true);
      }
    },
    onSuccess: (fresh, vars) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      if (vars?.noAi) {
        toast.success("Re-applying the latest processing to what the AI already found…");
        return;
      }
      if (vars?.barcode) {
        // The barcode branch runs INLINE, so `fresh` is the re-resolved row.
        toast.success(
          fresh.suggested_name
            ? `Barcode corrected - now reads as ${fresh.suggested_name}`
            : "Barcode corrected - no match yet for the new code.",
        );
        return;
      }
      if (vars?.imageFileId) {
        toast.success("Re-identifying from your photo…");
        return;
      }
      if (isPhotoItem) {
        // Detached on the server — the result isn't ready yet; the poll shows it.
        toast.success("Reading the photo with AI…");
        return;
      }
      // A hint / wrong / enrich re-derive also runs DETACHED (the web identify),
      // so `fresh` still carries the OLD name — never claim "updated: <old name>".
      // The 1.5s inbox poll surfaces the corrected name a moment later.
      if (vars?.hint || vars?.wrong || vars?.enrich) {
        toast.success("Re-checking - the name updates in a moment…");
        return;
      }
      toast.success(
        fresh.suggested_name
          ? `Lookup updated: ${fresh.suggested_name}`
          : "Re-ran — still no match. Fill it in manually.",
      );
    },
    onError: (e) => {
      setReading(false);
      toast.error(e instanceof ApiError ? e.message : String(e));
    },
  });
  // "This is good — lock it in": verify the current listing into the shared
  // barcode DB (no re-resolve, doesn't commit to inventory).
  const confirmBarcode = useMutation({
    mutationFn: () => api.confirmScanBarcode(activeSlug, item.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success("Locked into the barcode database - future scans of this code get this listing.");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Clear the local pulse once the server stamps a newer ai_suggested_at (the
  // identify finished — named or a "couldn't identify" note); cap it so a dropped
  // enrich can't pulse forever.
  useEffect(() => {
    if (reading && (item.ai_suggested_at ?? null) !== readingSnapshot.current) setReading(false);
  }, [item.ai_suggested_at, reading]);
  useEffect(() => {
    if (!reading) return;
    const t = setTimeout(() => setReading(false), 95_000);
    return () => clearTimeout(t);
  }, [reading]);
  // In flight = the local mutation is pending (optimistic, before the server has
  // even stamped pipeline_started_at) OR the server says the run is still going
  // (isRerunInFlight — the SAME signal the header count uses, so the spinner and
  // the "N finishing" pill can't disagree). `reading` alone stopped the moment the
  // name landed, ~60s before a real AI re-run actually finished.
  const rerunning = rerun.isPending || reading || isRerunInFlight(item);
  // "Replay" runs the SAME mutation with noAi — but showing it as
  // "Re-running the lookup…" with the AI sparkle made a token-free replay look
  // like a model call ("all the spinners are going incl the AI one"). Label the
  // in-flight variant honestly.
  const replayNoAi =
    (rerun.isPending && (rerun.variables as { noAi?: boolean } | undefined)?.noAi === true) ||
    ((item.suggested_metadata as { pipeline_kind?: string } | null)?.pipeline_kind === "replay" &&
      (rerunning || serverMatching));
  const aiWorking = rerunning || serverMatching;

  // Internal /api/v1 file URLs need the Bearer token a bare <img> can't
  // send — useImageSrc blob-loads those; external URLs pass through.
  // A catalog_image_url can 404 / hotlink-block (the broken-? the author hit): onError
  // marks that URL broken and we drop to the next rung — the server-cached file,
  // else the user's own photo — instead of leaving a dead image on the card.
  const [brokenSrcs, setBrokenSrcs] = useState<Set<string>>(new Set());
  const markBroken = (u: string | null) =>
    u && setBrokenSrcs((s) => (s.has(u) ? s : new Set(s).add(u)));
  const catalogFileUrl = item.catalog_image_file_id
    ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.catalog_image_file_id}/raw?variant=med`
    : null;
  const catalogUrl =
    [catalogFileUrl, item.catalog_image_url ?? null].find(
      (u): u is string => !!u && !brokenSrcs.has(u),
    ) ?? null;
  const yoursRawUrl = item.image_file_id
    ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${item.image_file_id}/raw?variant=med`
    : null;
  const yoursUrl = yoursRawUrl && !brokenSrcs.has(yoursRawUrl) ? yoursRawUrl : null;
  // The item's photograph, cropped out of a screenshot by the enrich. Kept as a
  // filmstrip pane of its own so it stays one tap away after a detour through
  // the web results — it is a picture of the ACTUAL item, so it is worth
  // returning to.
  const screenshotCropId =
    (item.suggested_metadata as { screenshot_crop_file_id?: string } | null)?.screenshot_crop_file_id ?? null;
  const cropRawUrl = screenshotCropId
    ? `/api/v1/orgs/${activeSlug}/modules/core-files/files/${screenshotCropId}/raw?variant=med`
    : null;
  const catalogImg = useImageSrc(catalogUrl);
  const yoursImg = useImageSrc(yoursUrl);
  const cropImg = useImageSrc(cropRawUrl && !brokenSrcs.has(cropRawUrl) ? cropRawUrl : null);
  // While a barcode's catalog image is UNVERIFIED — being checked against your
  // photo, or already flagged a mismatch — lead with YOUR photo, not the catalog
  // one. A barcode can resolve to a wrong/spam product (an action figure, a
  // lookup-site screenshot) whose race-fetched image reads as "the scan failed";
  // your own photo is never wrong. Once the check confirms, the catalog image
  // (a clean product shot) leads again.
  // The shared rule (lib/scanPhoto.ts) decides; this surface only maps roles to
  // the images it already resolved. Seven surfaces used to answer separately.
  const unverified = photoUnverified(item);
  const thumbRole = photoOrder(item).find((r) =>
    r === "catalog" ? !!catalogImg : r === "yours" ? !!yoursImg : false,
  );
  const thumb = thumbRole === "yours" ? yoursImg : thumbRole === "catalog" ? catalogImg : null;

  // Image viewer: click to zoom (the shared ImageLightbox — same viewer as the
  // web-photo "view full size"), revert the catalog image to the original
  // (preserved server-side on the first override), or use your own scan photo as
  // the catalog image. ONE filmstrip regardless of which image you click: the
  // item's own shots (catalog + yours, already-resolved blob urls above) followed
  // by the web photo candidates — so opening from the catalog shows the same
  // options as opening from a web tile (reported 2026-07-24). The candidates are
  // fetched by the PhotoOptions strip below and reported up via onItems.
  const [zoomIdx, setZoomIdx] = useState<number | null>(null);
  const [photoCandidates, setPhotoCandidates] = useState<ImageOption[]>([]);
  // The search that produced those candidates, owned HERE so the same one can
  // be driven from the inline picker or from inside the full-screen viewer.
  // Refining while the viewer is open is the whole point: that is where you are
  // actually comparing, so leaving it to retype a term was the detour.
  const [photoTerm, setPhotoTerm] = useState("");
  const [photoSearched, setPhotoSearched] = useState("");
  const [zoomTerm, setZoomTerm] = useState("");
  const zoomTermTouched = useRef(false);
  // Keep the viewer's box showing what was actually searched until the user
  // edits it, then leave their text alone.
  useEffect(() => {
    if (!zoomTermTouched.current) setZoomTerm(photoTerm || photoSearched);
  }, [photoTerm, photoSearched]);
  // YOUR photo leads, then the rest of what is already yours, then a divider,
  // then the web results.
  //
  // The strip is a comparison surface: you are deciding which of fourteen
  // candidates is a picture of the thing in front of you. The photo you took is
  // the REFERENCE you compare against, so it belongs at the fixed left edge
  // where the eye returns, not somewhere in the queue as tile three of fourteen
  // (reported 2026-08-17). Mixed in, the one image you can identify at a glance
  // becomes another one to hunt for.
  const ownItems: LightboxItem[] = [
    ...(yoursImg && yoursImg !== catalogImg ? [{ key: "yours", caption: "Your photo", url: yoursImg }] : []),
    ...(catalogImg ? [{ key: "catalog", caption: "Catalog image", url: catalogImg }] : []),
    ...(cropImg && cropImg !== catalogImg ? [{ key: "crop", caption: "From your screenshot", url: cropImg }] : []),
  ];
  const zoomItems: LightboxItem[] = [
    ...ownItems,
    ...photoCandidates.map((o, i) => ({
      key: o.url,
      caption: `${o.title} · ${o.source}`,
      href: o.source,
      url: o.url,
      thumbUrl: o.thumb,
      // The seam between what is yours and what the web offered. Only on the
      // first one, and only when there is something to its left to separate it
      // from.
      ...(i === 0 && ownItems.length > 0 ? { dividerBefore: true } : {}),
    })),
  ];
  const openZoom = (key: "catalog" | "yours") => {
    const i = zoomItems.findIndex((z) => z.key === key);
    if (i >= 0) setZoomIdx(i);
  };
  const openZoomUrl = (url: string) => {
    const i = zoomItems.findIndex((z) => z.url === url);
    if (i >= 0) setZoomIdx(i);
  };
  // "Use this image" on a web candidate in the viewer → set it as the catalog.
  const pickCatalogImage = useMutation({
    mutationFn: (url: string) =>
      api.setScanCatalogImage(activeSlug, item.id, url, {
        // The thumbnail the viewer is showing for this very candidate. If the
        // full-size original is hotlink-blocked, that visible picture is used
        // rather than the pick being refused.
        thumbUrl: photoCandidates.find((o) => o.url === url)?.thumb,
      }),
    onSuccess: () => {
      toast.success("Catalog photo updated");
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Revert is undo over a STACK, so the control lives as long as there is any
  // earlier image, and it names the one press lands on. The rule is pure and
  // unit-tested next door rather than inline here.
  const catalogHistory = catalogUndoHistory(
    item.suggested_metadata as { catalog_history?: unknown; orig_catalog?: unknown } | null,
  );
  const undoLabel = catalogUndoLabel(catalogHistory);
  const hasOrigCatalog = !!undoLabel;
  const catalogAction = useMutation({
    mutationFn: (action: "revert" | "use_own_photo" | "use_screenshot_crop") =>
      api.scanCatalogAction(activeSlug, item.id, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // ── image ops (scan-parity-final-mile.md Epic B) ────────────────────
  const invalidateInbox = () => void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
  const onErr = (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e));
  const rotate = useMutation({
    mutationFn: () => api.rotateScanPhoto(activeSlug, item.id, 90),
    onSuccess: invalidateInbox,
    onError: onErr,
  });
  const split = useMutation({
    mutationFn: () => api.splitScanItem(activeSlug, item.id),
    onSuccess: (r) => {
      toast.success(`Split into ${r.children.length} items`);
      invalidateInbox();
    },
    onError: onErr,
  });
  // "Keep as one" — the OTHER answer to the split question. Persisted, so the
  // offer doesn't ask again on the next render.
  const keepGrouped = useMutation({
    mutationFn: () => api.updateScanItem(activeSlug, item.id, { keep_grouped: true }),
    onSuccess: () => {
      toast.success("Kept as one record.");
      invalidateInbox();
    },
    onError: onErr,
  });
  // Several DIFFERENT things in one photo (units of the SAME thing are a quantity,
  // not a split). Offered only when the PHOTO was the point - see lib/splitOffer.
  // not a split — the observation pass draws that line). Free: this comes from the
  // vision call every photo scan already makes. Hidden once answered, once split,
  // and on a child that IS a split result.
  const multiItem = (() => {
    const m = (item.suggested_metadata ?? {}) as {
      photo_distinct?: number;
      photo_individuals?: Array<{ name: string; qty: number }>;
      keep_grouped?: boolean;
      split_from?: string;
      split_into?: string[];
    };
    if (
      !shouldOfferSplit({
        distinct: m.photo_distinct,
        hasBarcode: !!item.barcode_text,
        keepGrouped: !!m.keep_grouped,
        alreadySplit: !!m.split_from || !!m.split_into,
        status: item.status,
      })
    ) {
      return null;
    }
    return {
      distinct: m.photo_distinct,
      individuals: m.photo_individuals ?? [],
    };
  })();
  // In-app capture (shared CameraCaptureSheet). The inbox card has no live camera,
  // so the sheet acquires its own rear camera — still no iOS native camera launch.
  const [captureSheet, setCaptureSheet] = useState<"add" | "retake" | null>(null);
  const toFile = (b: Blob, tag: string) =>
    b instanceof File ? b : new File([b], `${tag}-${Date.now()}.jpg`, { type: "image/jpeg" });
  const addPhoto = useMutation({
    mutationFn: (v: Blob | { blob: Blob; uploaded?: boolean }) => {
      const blob = v instanceof Blob ? v : v.blob;
      const uploaded = v instanceof Blob ? false : !!v.uploaded;
      return api
        .uploadFile(activeSlug, toFile(blob, "photo"))
        .then(async (up) => {
          const added = await api.addScanPhoto(activeSlug, item.id, up.id, { uploaded });
          // A CAPTURE of a photo-sourced item still being triaged is the person
          // saying "read THIS" - the label, the spec sticker, the box. Re-read
          // with it now rather than leaving the pic inert behind a ↺ nobody
          // finds. A barcode item keeps the server's cross-check (its identity
          // came from the code, and a vision re-read would only second-guess
          // it); a camera-roll file stays attached only, as before.
          const reread = !uploaded && item.status === "pending" && !item.barcode_text;
          if (reread) await api.rerunScanAi(activeSlug, item.id, { imageFileId: up.id });
          return { added, reread };
        });
    },
    onSuccess: (r) => {
      setCaptureSheet(null);
      toast.success(
        r.reread
          ? "Photo added - reading it for details…"
          : item.status === "pending"
            ? "Photo added - tap ↺ on it to re-identify from this shot"
            : "Photo added",
      );
      invalidateInbox();
    },
    onError: onErr,
  });
  const retakeCatalog = useMutation({
    mutationFn: (b: Blob) =>
      api.uploadFile(activeSlug, toFile(b, "catalog")).then((up) => api.setScanCatalogFile(activeSlug, item.id, up.id)),
    onSuccess: () => {
      setCaptureSheet(null);
      toast.success("Catalog photo replaced with your shot");
      invalidateInbox();
    },
    onError: onErr,
  });
  // A receipt document, by the same test the inbox's upload door uses. Chosen
  // from the card, it is the paperwork for THIS item rather than a new intake:
  // the order is recorded in full and nothing lands in the inbox, because this
  // item is already here. See docs/design-decisions/receipt-or-provenance.md.
  const attachReceipt = useMutation({
    mutationFn: (file: File) =>
      api
        .uploadFile(activeSlug, file)
        .then((up) => api.scanReceipt(activeSlug, up.id, { origin: "upload", target_item_id: item.id })),
    onSuccess: () => {
      setCaptureSheet(null);
      toast.success("Receipt attached - its purchase is on record");
      invalidateInbox();
    },
    onError: onErr,
  });

  // "I'll photograph this" — the mark half of the one photo button. On a device
  // that can actually take the picture the button opens the camera instead and
  // never gets here.
  const setPhotoWanted = useMutation({
    mutationFn: (wanted: boolean) => api.updateScanItem(activeSlug, item.id, { photo_wanted: wanted }),
    onSuccess: (_r, wanted) => {
      toast.success(wanted ? "Waiting on your phone" : "Cleared");
      invalidateInbox();
    },
    onError: onErr,
  });
  const setPrimaryPhoto = useMutation({
    mutationFn: (fileId: string) => api.setScanPrimaryPhoto(activeSlug, item.id, fileId),
    onSuccess: invalidateInbox,
    onError: onErr,
  });
  const removeExtraPhoto = useMutation({
    mutationFn: (fileId: string) => api.removeScanPhoto(activeSlug, item.id, fileId),
    onSuccess: invalidateInbox,
    onError: onErr,
  });
  // Barcode editor: digits (spaces/dashes ok while typing) → Save re-runs the
  // lookup on the corrected code via rerun-ai {barcode}.
  // The confirm form's buttons render HERE, in the same stack the closed
  // state's commit pair uses, so the action anchor does not move when the
  // form opens.
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);
  const [fieldSlot, setFieldSlot] = useState<HTMLElement | null>(null);
  // Where the location drawer opens: at the SEAM, directly under the chip strip
  // whose LOCATION chip opened it. It used to render inside the form, which sits
  // below the photos and the web strip — so tapping a chip at the top of the
  // card opened a picker most of a screen further down, with everything you had
  // been looking at in between.
  const [locSlot, setLocSlot] = useState<HTMLElement | null>(null);
  const [editingBarcode, setEditingBarcode] = useState(false);
  const [barcodeDraft, setBarcodeDraft] = useState("");
  const barcodeDigits = barcodeDraft.replace(/[\s-]/g, "");
  const barcodeDraftValid =
    /^\d+$/.test(barcodeDigits) && [8, 12, 13, 14].includes(barcodeDigits.length);
  const saveBarcode = () => {
    if (!barcodeDraftValid || barcodeDigits === item.barcode_text) {
      setEditingBarcode(false);
      return;
    }
    setEditingBarcode(false);
    rerun.mutate({ barcode: barcodeDigits });
  };
  const extraPhotos = Array.isArray((item.suggested_metadata as { extra_photos?: unknown })?.extra_photos)
    ? ((item.suggested_metadata as { extra_photos: string[] }).extra_photos)
    : [];
  // Box-state: explicit set/clear (menu grammar — tapping the active state
  // clears it; the old cycle button hid the next state behind a blind tap).
  const boxState =
    (item.suggested_metadata as { box_state?: "item-in-box" | "empty-box" } | null)?.box_state ?? null;
  const setBoxState = useMutation({
    mutationFn: (v: "item-in-box" | "empty-box" | null) =>
      api.updateScanItem(activeSlug, item.id, { box_state: v }),
    onSuccess: invalidateInbox,
    onError: onErr,
  });
  // The "this scan IS a container" one-shot (a scanned storage tote becomes a
  // core-locations bin, identity + photo riding onto the bin's record).
  const [makeBinOpen, setMakeBinOpen] = useState(false);
  const containerish =
    !planContext &&
    item.status === "pending" &&
    hasLocations &&
    looksLikeContainer(
      item.suggested_name,
      (item.suggested_metadata as { category?: string } | null)?.category ?? null,
    );
  // Needs a human: no clean name, a low-trust or rate-limited lookup, or low
  // confidence — unless someone already said "looks fine".
  // The card's own copy of this test read the LOCAL `rateLimited`, which also
  // requires that nothing came back yet — so a rate-limited item that later got
  // a suggestion counted in the header's "to review" and showed nothing here.
  const flaggedForReview = needsScanReview(item);
  // "Where should this go?" — accept the suggested home (from where siblings
  // live). One tap sets it as the item's filed location.
  const acceptSuggestedLocation = useMutation({
    mutationFn: () => api.updateScanItem(activeSlug, item.id, { target_location_id: item.suggested_location_id }),
    onSuccess: () => {
      toast.success(`Filed into ${item.suggested_location_note?.split(" — ")[0] ?? "the suggested spot"}`);
      invalidateInbox();
    },
    onError: onErr,
  });
  const markReviewed = useMutation({
    mutationFn: () => api.updateScanItem(activeSlug, item.id, { reviewed: true }),
    onSuccess: () => {
      toast.success("Marked as looks-fine");
      invalidateInbox();
    },
    onError: onErr,
  });

  const ddg = (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      {/* ── collapsed header row (click = expand) ───────────────────── */}
      <div
        className="flex items-stretch cursor-pointer"
        onClick={() => (planContext && onCollapse ? onCollapse() : expanded ? setExpanded(false) : expandOnly())}
      >
        {/* Photo column: a CONSISTENT WIDTH (so every card's text starts at the
            same x), stretched to the row's full height — a book cover / product
            shot reads far better big. Wider now (the select checkbox moved ONTO
            it as a top-left overlay, freeing its old column), and object-CONTAIN
            so a tall bottle/tub shows in full instead of a cropped centre strip.
            min-h keeps a short card's image sensible.

            max-h BOUNDS IT. `h-full` inside a column with no determinate height
            falls back to the image's intrinsic size, so the picture decided how
            tall the row was: a spice grinder shot at roughly 1:3, drawn 112px
            wide, made a 336px card holding one line of text and a strip of
            empty space (reported 2026-08-14 - "the aspect ratio of the image
            makes the box too tall, and this is a bad use of screen real
            estate"). object-contain still shows the whole product; it is simply
            no longer allowed to set the card's height. */}
        <div className="relative w-24 sm:w-28 shrink-0 self-stretch min-h-[4.5rem] max-h-40 rounded-l-xl border-r border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 flex items-center justify-center overflow-hidden">
          {thumb ? (
            <img
              src={thumb}
              alt={item.suggested_name ?? item.barcode_text ?? ""}
              className="w-full h-full object-contain"
              // NOT lazy: an EXTERNAL catalog URL (a user-picked web/dealer photo)
              // with loading="lazy" stayed unloaded on the closed card — the
              // intersection observer saw the card at 0-height on first render and
              // never re-checked, so it looked broken until opening the accordion
              // forced a reflow. Internal thumbs are blob URLs (load instantly),
              // so only external ones showed the bug. Eager-load the small thumb.
              // The expanded views aren't lazy either; this matches them.
              onError={() => markBroken(catalogImg ? catalogUrl : yoursRawUrl)}
            />
          ) : (
            <ScanLine size={26} className="text-faint dark:text-slate-600" />
          )}
          {onToggleSelect && (
            <div
              className="absolute top-1 left-1 rounded bg-white/85 dark:bg-slate-900/75 p-0.5 shadow-sm"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={!!selected}
                onChange={onToggleSelect}
                aria-label="Select for bulk action"
                className="h-4 w-4 accent-cobble-600 cursor-pointer block"
              />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 p-3">
          {/* The scan usually KNOWS the name before the matchmaker finishes —
              never replace a known title with a status line. Status renders as
              a subtle chip beside it; the pulse only owns the title slot when
              there's genuinely nothing to show yet. */}
          {/* Title and subtitle share ONE flex row that wraps. A short name with a
              short subtitle ("Baby Carrots" / "from Lidl") then reads as one
              line instead of spending two on eleven characters, and a long name
              or a busy subtitle still gets its own line — the wrap decides,
              rather than a width guess that is wrong on somebody's phone. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
          <div className="font-medium text-content dark:text-mortar-100 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            {item.suggested_name ? (
              <>
                <span className="break-words min-w-0 max-w-full">{item.suggested_name}</span>
                {rerunning || serverMatching ? (
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-accent animate-pulse">
                    {replayNoAi ? "replaying" : rerunning ? "re-running" : "AI reading…"}
                  </span>
                ) : matchFailed ? (
                  <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-amber-700 dark:text-amber-300">
                    matching failed
                    <button
                      type="button"
                      onClick={() => rerun.mutate({})}
                      className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100 transition"
                    >
                      retry
                    </button>
                  </span>
                ) : null}
              </>
            ) : rerunning ? (
              <span className="text-accent animate-pulse">
                {replayNoAi ? "Re-applying the latest processing…" : "Re-running the lookup…"}
              </span>
            ) : serverMatching ? (
              <span className="text-accent animate-pulse">
                {replayNoAi ? "Re-applying the latest processing…" : "AI is reading the details…"}
              </span>
            ) : rlActive ? (
              <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <Loader2 size={13} className="animate-spin shrink-0" />
                Rate-limited - retrying…
              </span>
            ) : readingReceipt ? (
              <span className="text-muted">That’s a receipt - reading its line items…</span>
            ) : cantIdentify && identifyOff ? (
              // Not "couldn't": nothing tried. The banner up top says the plan
              // has no AI, and this card said "couldn't identify" under it, with
              // an Identify button that would fail the same way (blank
              // workspace e2e, 2026-09-01). Naming it by hand still works.
              <span className="text-muted">
                No AI to read this {idNoun} yet (<Link to={`/w/${activeSlug}/ai`} className="underline hover:text-content" onClick={(e) => e.stopPropagation()}>set it up</Link>) - or name it:
              </span>
            ) : cantIdentify ? (
              <span className="text-muted">Couldn’t identify this {idNoun}  - name it:</span>
            ) : awaitingFresh ? (
              <span className="text-faint italic">Awaiting lookup…</span>
            ) : (
              // Settled (matchmaker ran / a tentative table) but still nameless.
              <span className="text-muted">Name this {idNoun}:</span>
            )}
            {(item.quantity ?? 1) > 1 && (
              <span className="shrink-0 inline-flex items-center rounded-full bg-cobble-600 text-white text-[11px] font-semibold overflow-hidden">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    qtyPatch.mutate(Math.max(1, (item.quantity ?? 1) - 1));
                  }}
                  disabled={qtyPatch.isPending}
                  className="px-1.5 py-0.5 hover:bg-cobble-700 disabled:opacity-50"
                  title="Decrease quantity"
                  aria-label="Decrease quantity"
                >
                  −
                </button>
                <span className="px-1 tabular-nums" title="Quantity (scanned this many times)">
                  ×{item.quantity}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    qtyPatch.mutate((item.quantity ?? 1) + 1);
                  }}
                  disabled={qtyPatch.isPending}
                  className="px-1.5 py-0.5 hover:bg-cobble-700 disabled:opacity-50"
                  title="Increase quantity"
                  aria-label="Increase quantity"
                >
                  +
                </button>
              </span>
            )}
          </div>
          <div className="text-[11px] font-mono text-faint dark:text-slate-500 min-w-0 whitespace-normal break-words sm:truncate">
            {(() => {
              // Build the subtitle from the fields that are PRESENT and join them
              // with " · ". An absent field (a photo-identified book has no
              // barcode/ISBN) must not leave a dangling leading separator — that
              // reads as "something's missing here". Never a leading/trailing dot.
              const segs: ReactNode[] = [];
              if (item.barcode_text) {
                // Say where it CAME FROM. "read from photo" over an emailed
                // eBay receipt was simply untrue (reported 2026-08-31); the
                // vocabulary lives with the server that stamps it, in
                // modules/core-scan/src/services/barcode-source.ts.
                const codeNote = BARCODE_SOURCE_NOTE[
                  (item.suggested_metadata as { barcode_source?: string } | null)?.barcode_source ?? ""
                ];
                segs.push(
                  <>
                    {item.barcode_text}
                    {codeNote && <span className="text-amber-600 dark:text-amber-500"> ({codeNote})</span>}
                  </>,
                );
              }
              // A book's ISBN is its identifier — surface it up FRONT (like a
              // barcode) from the top match's `isbn` field, when there's no
              // scanned barcode. Dropped from the fill-chips below so it isn't
              // shown twice. (Hit-or-miss: only when the identify captured one.)
              const isbnKey = topCand ? Object.keys(topCand.fields).find((k) => /^isbn$/i.test(k)) : undefined;
              const isbn = isbnKey ? String(topCand!.fields[isbnKey] ?? "").trim() : "";
              if (isbn && !item.barcode_text) segs.push(<span>ISBN {isbn}</span>);
              // Creator (author/director/…) then publisher/brand — a book reads
              // "Laura Ingalls Wilder · Scholastic".
              const creator = creatorOf(item);
              const brand = item.suggested_manufacturer?.trim() || null;
              const cb = [creator, brand].filter((p, i, a): p is string => !!p && a.indexOf(p) === i);
              if (cb.length) segs.push(cb.join(" · "));
              // Where it was BOUGHT, for a line off a receipt. A receipt names
              // the shop and never the maker, so without this a line reads
              // "Croissant" with nothing to say which croissant. Deliberately
              // not written into the brand field: the shop is where you bought
              // it, and a tin of branded beans from the same receipt would then
              // claim the supermarket made it.
              const boughtFrom = (item.suggested_metadata as { receipt_vendor?: string } | null)?.receipt_vendor;
              if (!brand && boughtFrom?.trim()) segs.push(`from ${boughtFrom.trim()}`);
              // WHO sold it, when the receipt named someone other than the shop -
              // a marketplace order has both, and they are different facts. Kept
              // by the parser since receipts shipped and shown nowhere until now.
              const soldBy = (item.suggested_metadata as { receipt_seller?: string } | null)?.receipt_seller;
              if (soldBy?.trim() && soldBy.trim() !== boughtFrom?.trim()) segs.push(`sold by ${soldBy.trim()}`);
              if (item.suggested_sku) segs.push(item.suggested_sku);
              // Where it's being FILED — the bin set by "Set location" (bulk or
              // per-item). This is target_location_id, the authoritative
              // destination, and it's distinct from any AI-guessed location-ish
              // custom field (a bundle's `room`). Without showing it, using "Set
              // location" changed nothing visible on the card. Falls back to the
              // free-text scan_area stamped at scan time when no bin is set.
              const filedInto = item.target_location_id
                ? (cardLocs.data?.items ?? []).find((l) => l.id === item.target_location_id)
                : null;
              if (filedInto) segs.push(<span className="text-accent">📍 {filingLabel(filedInto)}</span>);
              else if (item.scan_area) segs.push(`📍${item.scan_area}`);
              const ps = (item.suggested_metadata as { pack_size?: number } | null)?.pack_size;
              if (ps) segs.push(<span className="text-accent">{ps}-pack</span>);
              const bs = (item.suggested_metadata as { box_state?: string } | null)?.box_state;
              if (bs) segs.push(<span>📦 {bs === "empty-box" ? "empty box" : "in box"}</span>);
              if ((item.suggested_metadata as { split_from?: string } | null)?.split_from)
                segs.push(<span className="text-accent">✂ from split</span>);
              if (item.source_url) {
                let host = "";
                try {
                  host = new URL(item.source_url).hostname.replace(/^www\./, "");
                } catch {
                  /* not a URL */
                }
                if (host)
                  segs.push(
                    <a
                      href={item.source_url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-accent hover:underline"
                    >
                      {host} ↗
                    </a>,
                  );
              }
              return segs.map((s, i) => (
                <Fragment key={i}>
                  {i > 0 && " · "}
                  {s}
                </Fragment>
              ));
            })()}
          </div>
          </div>
          {/* Routine provenance ("Identified via go-upc.") no longer costs the
              closed card a line - it lives in the Source data box. This line is
              for a WARNING a triager must see, and it stays amber whether the
              card is open or closed (see scanNotesPlacement). */}
          {notesPlacement.amber && (
            <div className={`text-[11px] mt-0.5 text-amber-600 dark:text-amber-400 ${expanded ? "" : "line-clamp-1"}`}>
              {item.ai_notes}
            </div>
          )}
          {/* One-tap accept the photo's identification when the cross-check read a
              real product off the label (and it differs from the current name). */}
          {photoSuggestedName && photoSuggestedName !== (item.suggested_name ?? "") && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                applyPhotoName.mutate();
              }}
              disabled={applyPhotoName.isPending}
              className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition disabled:opacity-50"
              title="Rename to what the photo shows - and report the barcode fix"
            >
              <Sparkles size={12} className="shrink-0" />
              Use photo’s name: “{photoSuggestedName}”
            </button>
          )}
          {/* The photo holds several DIFFERENT things. The observation pass (which
              every photo scan already pays for) counted them and named them, so
              ask the only question that matters — one record, or one each? — right
              here on the closed card. Buried in the open card it may as well not
              exist: nobody expands a card to discover a question they didn't know
              they had. */}
          {multiItem && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="mt-1.5 rounded-md border border-cobble-500/50 bg-cobble-600/10 px-2.5 py-2"
            >
              <div className="flex items-start gap-1.5 text-[11px] text-content dark:text-mortar-100">
                <Sparkles size={12} className="shrink-0 mt-0.5 text-accent" />
                <span>
                  <strong>{multiItem.distinct} different items</strong> in this photo. Keep
                  them together as one record, or split into individuals?
                </span>
              </div>
              {multiItem.individuals.length > 0 && (
                <ul className="mt-1 ml-5 space-y-0.5">
                  {multiItem.individuals.map((ind, i) => (
                    <li key={i} className="text-[11px] text-muted truncate">
                      · {ind.name}
                      {ind.qty > 1 && <span className="text-faint"> ×{ind.qty}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => split.mutate()}
                  disabled={split.isPending || keepGrouped.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-cobble-500 transition disabled:opacity-50"
                >
                  <Scissors size={11} className="shrink-0" />
                  {split.isPending
                    ? "Splitting…"
                    : `Split into ${multiItem.distinct} items`}
                </button>
                <button
                  type="button"
                  onClick={() => keepGrouped.mutate()}
                  disabled={split.isPending || keepGrouped.isPending}
                  className="rounded-md border border-line dark:border-slate-600 px-2 py-1 text-[11px] text-muted hover:text-content dark:hover:text-mortar-100 transition disabled:opacity-50"
                >
                  Keep as one
                </button>
              </div>
            </div>
          )}
          {/* Whatever OTHER modules declared into a scan item, rendered
              without this page learning who they are or what they say. The
              receipt-lines banner arrives through here; core-scan names no
              contributor and hands over only its own receipt group id as a
              hint, which is the contributor's to interpret. Same seam that
              puts price history on a part page without inventory naming
              purchases — see docs/architecture/module-coupling-census.md. */}
          {receiptGroupId && (
            <ContributedDetailPanels
              target="core-scan:item"
              // NOT the universal side-cars. An inbox row is not a record: its
              // id belongs to the scan item, and filing it creates a DIFFERENT
              // record with a different id. A conversation or a tag attached
              // here is silently orphaned the moment somebody acts on the row,
              // which is worse than not offering one.
              //
              // This slot was built for one named contributor (the receipt
              // lines banner) and is gated on a receipt group for that reason.
              universal={false}
              ctx={{
                slug: activeSlug,
                entityId: item.id,
                entityTitle: item.suggested_name ?? "this item",
                hints: {
                  receipt_group_id: receiptGroupId,
                  // A line that came OFF this receipt sits in the inbox beside
                  // its siblings, so a panel counting them is describing the
                  // rows immediately above and below it. The panel that earns
                  // its place is the other case: a receipt attached to an item
                  // you already had, where the rest of the order is nowhere on
                  // screen. Say which case this is and let the panel decide.
                  siblings_visible: item.source_kind === "receipt" ? "yes" : "no",
                },
              }}
            />
          )}
          {cantIdentify && <NameItInline slug={activeSlug} itemId={item.id} />}
          {/* One-tap correction: a barcode whose name looks wrong (always
              available, nudged for low-trust short codes). Renaming reports the
              fix to the shared Barcode Intelligence DB so the next scan is right. */}
          {/* The standing "Not right? Fix the name" offer moved to the card's ⋯
              menu - a closed card's height should be its IMAGE's height, and an
              offer nobody has taken is not worth a line (same rule as the drive
              offer). Only the LOW-TRUST warning variant keeps its line, and the
              inline editor still appears right here once summoned. It is the
              amber warning's own action, so it goes wherever the warning goes -
              open or closed - rather than disappearing at the moment someone
              opened the card to act on it. */}
          {barcodeIdentified && correcting && (
            <CorrectNameInline
              slug={activeSlug}
              itemId={item.id}
              initial={item.suggested_name ?? ""}
              onDone={() => setCorrecting(false)}
            />
          )}
          {barcodeIdentified && !correcting && lowTrust && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCorrecting(true);
              }}
              className="mt-0.5 text-[11px] underline decoration-dotted underline-offset-2 text-amber-600 dark:text-amber-400"
            >
              Double-check: fix the name
            </button>
          )}
          {/* "You already have one of these" — its OWN line, because the answer
              has to NAME the record. As an action segment on the route chip it
              read "Vehicles | Same one?", which can't say same as WHAT (reported
              2026-07-16). Sits above the chips so it's read before the routing,
              which is the right order: whether this is a duplicate decides
              whether the routing matters at all. Opens the card rather than
              merging on the spot — the banner in there shows what would be
              filled, and merging into something you own is a decision. */}
          {!planContext && alreadyTracked && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" onClick={(e) => e.stopPropagation()}>
              <span className="inline-flex min-w-0 items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
                <CheckCircle size={12} className="shrink-0" />
                <span className="min-w-0">
                  You already have{" "}
                  <span className="font-semibold break-words">{trackedMatch!.title}</span>
                  <span className="text-muted dark:text-slate-400">  - is this the same one?</span>
                </span>
              </span>
              <button
                type="button"
                onClick={() => (topCand ? openForm(topCand) : setExpanded(true))}
                className="shrink-0 inline-flex items-center gap-1 rounded-full border border-emerald-500 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30 px-2.5 py-1 text-[11px] font-medium transition"
              >
                Compare &amp; merge
              </button>
              {/* Buying MORE of it is a different answer to "is this the same
                  one?" than filling in what the scan learned, and on a grocery
                  re-scan it is the usual one. It carries the cadence chips and
                  the over-buy question, which had no reachable home before. */}
              <RepurchaseControls itemId={item.id} quantity={Math.max(1, item.quantity || 1)} />
            </div>
          )}
          {/* ONE row for everything the card says about routing + fields:
              the SERIES tag, the routing chip(s) to file into, AND the field
              VALUES the top match fills. Keeping these on a single wrapping row
              (they were two stacked rows) stops the text strip growing taller
              than the cover image beside it. On phones only the TOP routing
              match shows + a "+N" to expand; desktop shows them all. Field chips
              skip anything already in the subtitle (author, publisher/brand,
              ISBN) so there's no echo. */}
          {!planContext && (seriesOf(item) || candidates.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {seriesOf(item) && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/5 px-2 py-0.5 text-[11px] font-medium text-accent min-w-0"
                  title={`Part of the "${seriesOf(item)}" series`}
                >
                  <Library size={11} className="shrink-0" />
                  <span className="truncate">{seriesOf(item)}</span>
                  <span className="opacity-60 shrink-0">series</span>
                </span>
              )}
              {/* ONE destination control. The route used to be a split chip
                  whose left half opened the form, with the OTHER candidates as
                  separate chips beside it - so the same commit was offered
                  three ways and the alternatives looked like different actions
                  rather than different answers to one question. Now: pick the
                  table, press Add. */}
              {dest && (
                // FIRST on the row, whatever else the item has. A series chip
                // rendered ahead of it on the one card that had one, so the pill
                // sat in a different place there than on every other card and
                // the eye had to hunt for it (reported 2026-08-20). `order-first`
                // rather than moving the markup: the series stays next to the
                // name it qualifies for a reader, and only the layout changes.
                // On a phone the content column is ~170px and the bundle
                // suggestion ("Groceries?") used to sit beside the pill INSIDE
                // this wrapper, so the destination name got 6px and read "I…"
                // (measured on the live inbox, 2026-09-01). The wrapper wraps
                // there, the suggestion takes the next line, the verb drops
                // "& add", and the name keeps a floor. The walk asserts it.
                <span className="relative inline-flex max-w-full order-first max-sm:w-full max-sm:flex-wrap">
                <span
                  className={
                    tentativeRoute
                      ? "inline-flex max-w-full max-sm:w-full items-stretch rounded-full overflow-hidden border border-dashed border-cobble-500 text-content dark:text-mortar-100 text-xs font-medium"
                      : "inline-flex max-w-full max-sm:w-full items-stretch rounded-full overflow-hidden border border-cobble-600 bg-cobble-600 text-white text-xs font-medium"
                  }
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* A native <select> paints the OS popup ON TOP of the pill,
                      covering the thing you are choosing. This is our own menu,
                      anchored under it. */}
                  {/* max-sm:flex-1 - on a phone the pill is full-width and this
                      region absorbs the slack, so the table's NAME gets the room
                      ("Home Invento…" at 61px of 91, second census 2026-08-30)
                      and Add sits flush right. */}
                  <span className="relative inline-flex min-w-0 items-center max-sm:flex-1">
                    <button
                      type="button"
                      ref={destBtnRef}
                      onClick={(e) => {
                        e.stopPropagation();
                        destOpen ? closeDest() : openDest();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && destOpen) closeDest();
                      }}
                      title="Which table this gets filed into"
                      aria-haspopup="listbox"
                      aria-expanded={destOpen}
                      className={
                        "inline-flex min-w-0 items-center gap-1 pl-2.5 max-sm:pl-2 pr-2 py-1 transition " +
                        (tentativeRoute ? "hover:bg-cobble-600/10" : "hover:bg-cobble-700")
                      }
                    >
                      <Sparkles size={11} className="shrink-0 max-sm:hidden" />
                      <span className="truncate max-sm:min-w-[4rem]">
                        {dest.label}
                        {tentativeRoute ? "?" : ""}
                      </span>
                      {destOptions.length > 1 && <ChevronDown size={11} className="shrink-0 opacity-80 max-sm:hidden" />}
                    </button>
                  </span>
                  {quickConfirmReady ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        quickConfirm.mutate();
                      }}
                      disabled={quickConfirm.isPending}
                      title={
                        topBundle
                          ? `Install ${dest.label} and add this to it, with the scan's values as shown`
                          : `Add to ${dest.label} as shown`
                      }
                      className="inline-flex shrink-0 items-center gap-1 border-l border-white/25 bg-emerald-600 hover:bg-emerald-500 pl-2 pr-2.5 py-1 transition disabled:opacity-60"
                    >
                      {/* A table that has to be INSTALLED first commits from
                          here too. It used to be suppressed so a second brown
                          button could carry the same mutation on its own, which
                          left the pill offering Review while the real commit sat
                          outside it (reported 2026-08-19). The word changes; the
                          action is the one this button always ran. */}
                      {topBundle ? (
                        <Download size={11} className={`shrink-0 ${quickConfirm.isPending ? "animate-pulse" : ""}`} />
                      ) : (
                        <CheckCircle size={11} className={`shrink-0 ${quickConfirm.isPending ? "animate-pulse" : ""}`} />
                      )}
                      {quickConfirm.isPending
                        ? topBundle
                          ? "Installing…"
                          : "Adding…"
                        : topBundle
                          ? <>Install<span className="max-sm:hidden"> &amp; add</span></>
                          : "Add"}
                    </button>
                  ) : (
                    // Withheld on purpose: a keyword-only guess, or a table that
                    // has to be INSTALLED first. Both deserve the explaining
                    // step, so they open the form instead of committing.
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openForm(dest);
                      }}
                      title={
                        tentativeRoute
                          ? `A keyword guess (no AI) - open to review before filing into ${dest.label}`
                          : `Review before adding to ${dest.label}`
                      }
                      className={
                        "inline-flex shrink-0 items-center gap-1 border-l pl-2 pr-2.5 py-1 transition " +
                        (tentativeRoute
                          ? "border-cobble-500/50 hover:bg-cobble-600/10"
                          : "border-white/25 hover:bg-cobble-700")
                      }
                    >
                      Review
                    </button>
                  )}
                </span>
                {/* The route was answered against the workspace as it was. A table
                    that has appeared since is offered, never applied: a route you
                    can see and ignore costs a glance, one that moves under you
                    costs your trust. */}
                {staleHint && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDestKey(entryKey(staleHint.entry.module, staleHint.entry.instance));
                    }}
                    className="ml-1.5 max-sm:ml-0 max-sm:mt-1 max-sm:basis-full shrink-0 inline-flex items-center gap-1 rounded-full border border-ember-300 dark:border-ember-700 bg-ember-50 dark:bg-ember-950/30 px-2 py-0.5 text-[11px] text-ember-700 dark:text-ember-300 hover:bg-ember-100 dark:hover:bg-ember-900/40 transition"
                    title={`${staleHint.label} was set up after this scan was routed. Tap to file it there instead.`}
                  >
                    {staleHint.label}?
                  </button>
                )}
                    {destOpen && destRect && createPortal(
                      <>
                        {/* click anywhere else to dismiss */}
                        <div className="fixed inset-0 z-[60]" onClick={(e) => { e.stopPropagation(); closeDest(); }} />
                        <div
                          role="listbox"
                          style={{ top: destRect.top, left: destRect.left }}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              closeDest();
                              return;
                            }
                            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                            e.preventDefault();
                            const opts = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
                            const at = opts.indexOf(document.activeElement as HTMLButtonElement);
                            const next = e.key === "ArrowDown" ? Math.min(at + 1, opts.length - 1) : Math.max(at - 1, 0);
                            opts[next]?.focus();
                          }}
                          className="fixed z-[61] min-w-[13rem] max-w-[18rem] rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg py-1 flex flex-col"
                        >
                          {destOptions.map((c) => {
                            const k = entryKey(c.module, c.instance);
                            const on = k === entryKey(dest.module, dest.instance);
                            return (
                              <button
                                key={k}
                                type="button"
                                role="option"
                                aria-selected={on}
                                autoFocus={on}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDestKey(k);
                                  closeDest();
                                }}
                                className={
                                  "flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition " +
                                  (on
                                    ? "text-accent font-medium bg-subtle/60 dark:bg-slate-800/60"
                                    : "text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800")
                                }
                              >
                                <CheckCircle size={11} className={on ? "shrink-0" : "shrink-0 opacity-0"} />
                                <span className="min-w-0 truncate">
                                  {c.label}
                                  {c.bundle_external_id ? " · installs on add" : ""}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </>,
                      document.body,
                    )}
                </span>
              )}
              {/* The editable chips land here while the form is open, in the
                  SAME row as the destination pill - so the fields sit with the
                  thing they are fields of. */}
              {formOpen && <span ref={setFieldSlot} className="contents" />}
              {candidates.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded(true);
                  }}
                  title="See the other matches"
                  className="sm:hidden inline-flex items-center rounded-full px-2 py-1 text-xs font-medium border border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:border-cobble-400 shrink-0"
                >
                  +{candidates.length - 1}
                </button>
              )}
              {/* …and the field VALUES the top match fills — inline on the SAME
                  row now, wrapping only if the row genuinely runs out of width. */}
              {topCand &&
                (() => {
                  const brand = (item.suggested_manufacturer ?? "").trim().toLowerCase();
                  const creator = (creatorOf(item) ?? "").trim().toLowerCase();
                  const entries = Object.entries(topCand.fields).filter(([k, v]) => {
                    if (/^isbn$/i.test(k)) return false; // shown in the subtitle now
                    const val = String(v).trim().toLowerCase();
                    return val && val !== brand && val !== creator;
                  });
                  if (entries.length === 0) return null;
                  // The row wraps, so let it breathe: cap only a genuinely long
                  // tail, and never render "+1" — that summary chip costs as
                  // much width as the field chip it hides (reported 2026-07-18).
                  const MAX = 6;
                  const shown = entries.length <= MAX + 1 ? entries : entries.slice(0, MAX);
                  const extra = entries.length - shown.length;
                  // The category chip shows the SAME label the session header
                  // does. Which field is the category comes from the table's
                  // declared axis, not from spotting a field whose value equals
                  // the candidate's category - that guess missed whenever the two
                  // had drifted, which is exactly when it mattered.
                  const axisKey = declaredCategoryAxis(menu, topCand);
                  // What the row is NOT showing: the filled fields past the cap,
                  // plus every field this table declares that came back empty.
                  // Both are "more fields live in here", so they count as one
                  // affordance rather than two competing "+N" chips.
                  const unfilled = unfilledFieldLabels(menu, topCand);
                  const more = extra + unfilled.length;
                  const moreTitle = [
                    ...entries.slice(shown.length).map(([k, v]) => `${menuFieldLabel(menu, topCand, k)}: ${v}`),
                    ...unfilled.map((l) => `${l}: empty`),
                  ].join(", ");
                  return (
                    <>
                      {/* A value the scan got wrong is a value you have to be
                          able to correct, and reading it while the only way to
                          change it is a separate summon is its own annoyance
                          ("Acquired from Facebook Marketplace is great! but
                          it's a field that I still need to be able to edit").
                          The chip stays a chip and gains the obvious gesture:
                          tap the value to open the form on this route with the
                          fields pre-filled. */}
                      {!formOpen && shown.map(([k, v]) => (
                        <button
                          key={k}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openForm(topCand);
                          }}
                          className="inline-flex items-center gap-1 rounded-md bg-subtle/60 dark:bg-slate-800/60 border border-line/70 dark:border-slate-700/70 px-1.5 py-0.5 text-[11px] text-content dark:text-mortar-200 min-w-0 hover:border-cobble-400 dark:hover:border-cobble-600 transition"
                          title={`${menuFieldLabel(menu, topCand, k)}: ${String(v)} — tap to edit`}
                        >
                          <span className="text-faint shrink-0">{menuFieldLabel(menu, topCand, k)}</span>
                          <span className="truncate">
                            {k === axisKey || (topCand.category && v === topCand.category)
                              ? categoryChipLabel(String(v), sessionCategoryLabel)
                              : String(v)}
                          </span>
                        </button>
                      ))}
                      {/* "+N more fields" said nothing anyone could act on
                          ("no one knows that's what it means so as far as they
                          know they can't edit or see anything") and the number
                          was wrong besides: unfilledFieldLabels returns [] when
                          the menu has not loaded, so it collapsed to the chip
                          overflow — "+1" on a table with six hidden fields.
                          The count is gone. This says what it opens, which is a
                          form that now lists every field by name. */}
                      {!formOpen && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openForm(topCand);
                          }}
                          className="text-[11px] text-faint shrink-0 px-1 underline decoration-dotted underline-offset-2 hover:text-accent transition"
                          title={more > 0 ? moreTitle : "Open every field for this item"}
                        >
                          All fields
                        </button>
                      )}
                    </>
                  );
                })()}
            </div>
          )}
          {/* The workspace has AI but this match came from the keyword floor —
              the model call failed and the code fell back. Silent downgrade is
              how a lexical guess ends up looking settled; say it, offer the
              retry (scan-inbox-ux-review.md F4). */}
          {aiDowngraded && !planContext && (
            <div
              className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-amber-700 dark:text-amber-400"
              onClick={(e) => e.stopPropagation()}
            >
              <Sparkles size={11} className="shrink-0" />
              <span>Matched by keywords: the AI didn’t answer.</span>
              <button
                type="button"
                onClick={() => rerun.mutate(undefined)}
                disabled={aiWorking || !canRerunLookup(item)}
                className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200 disabled:opacity-50"
              >
                Retry with AI
              </button>
            </div>
          )}
          {/* A scanned storage tote is usually about to BECOME a bin — offer the
              one-shot right on the closed card (buried in a menu it may as well
              not exist for the flow it exists for). */}
          {containerish && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
              <span className="inline-flex items-center gap-1.5 text-muted dark:text-slate-400">
                📦 Looks like a storage container.
              </span>
              <button
                type="button"
                onClick={() => setMakeBinOpen(true)}
                className="inline-flex items-center gap-1 rounded-full border border-cobble-400 dark:border-cobble-600 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-cobble-50 dark:hover:bg-cobble-900/30 transition"
              >
                Turn into a bin
              </button>
            </div>
          )}
          {candidates.length === 0 && serverMatching && (
            <div className="text-[11px] text-faint italic mt-1">finding the best table…</div>
          )}
          {/* The top match is a bundle you don't have (a scanned VIN → Vehicles).
              Installing + filing lives in the destination pill above, which is
              where every other commit already lives — this used to be a SECOND
              brown button running the identical mutation, which meant the pill
              beside it had to offer "Review" instead of committing, and the real
              action sat outside the control that names the destination.
              What remains is the quiet way in: adjust the fields first. */}
          {topBundle && (
            <div className="mt-2" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => openForm(topCand ?? undefined)}
                className="text-[11px] text-muted hover:text-accent underline"
              >
                edit fields first
              </button>
            </div>
          )}
        </div>
        {/* Stack the actions VERTICALLY (mobile + desktop) so the title gets the
            full width and reads in full — a horizontal cluster squeezed the name
            ("RAM EZ-Roll'r …"). self-stretch + justify-between spreads them over
            the card's full height: rerun at the top, discard centered, the
            expand chevron pinned near the bottom (rather than a tight top cluster). */}
        {/* THE one image control on a closed card. Everything rarer (retake for
            catalog, another angle, split) stays in the ⋯ menu beside it.
            One button, one sentence: "I'll photograph this." The only thing
            that varies is now or later, and the DEVICE answers that (see
            lib/photoDevice.ts) rather than a setting or a menu - so the button
            means the same thing on every machine and needs no explaining.

            `self-start`, not centred in the rail: the rail is deliberately
            spread over the card's height, and a control that moves depending on
            how tall a card happens to be is a control you have to look for. Top
            of the card is the title's first line, and it stays there when a long
            title wraps to two - which is the case that would otherwise push it
            somewhere different on every row. */}
        {item.status === "pending" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const act = photoPressAction(measureDevice(), photoWanted);
              // "I'll photograph this" is EVIDENCE about the object, so the
              // capture goes through the add-photo door (the server identifies
              // an unnamed item from it, cross-checks a named one). It used to
              // open the RETAKE sheet, which only swaps the display photo -
              // "did not trigger an AI rerun to get info from the new image"
              // (reported 2026-08-30).
              if (act === "capture") setCaptureSheet("add");
              else setPhotoWanted.mutate(act === "mark");
            }}
            disabled={setPhotoWanted.isPending}
            aria-pressed={photoWanted}
            title={
              photoWanted
                ? "Waiting for your photo - tap to clear"
                : "I'll photograph this myself"
            }
            className={`relative shrink-0 self-start mt-2 mr-0.5 rounded-lg border p-1.5 transition disabled:opacity-50 ${
              photoWanted
                ? "border-cobble-400 bg-cobble-500/20 text-cobble-200"
                : "border-transparent text-faint hover:border-line hover:text-accent"
            }`}
          >
            <Camera size={14} />
            {photoWanted && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400" />
            )}
          </button>
        )}
        <div className="flex flex-col items-center justify-between shrink-0 self-stretch py-2 pr-0.5" onClick={(e) => e.stopPropagation()}>
          {/* The item's rare tools. They lived under the photos, where the row
              they needed cost more vertical space than the controls were worth
              (reported 2026-08-11). The rail is where this card's other verbs
              already are, and putting them here makes them reachable without
              expanding at all. */}
          <HeaderMenu
            width={252}
            align="right"
            trigger={({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-label="More item tools"
                title="Split, retake, box state, turn into a bin"
                className="text-faint hover:text-accent p-1.5"
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          >
              {({ close }) => (
                <>
                  {item.image_file_id && item.status === "pending" && (
                    <MenuItem
                      icon={<Scissors size={14} />}
                      label={split.isPending ? "AI is splitting…" : "Split into items"}
                      hint="Several different things in one photo"
                      disabled={split.isPending}
                      onClick={() => {
                        close();
                        split.mutate();
                      }}
                    />
                  )}
                  <MenuItem
                    icon={<Camera size={14} />}
                    label={retakeCatalog.isPending ? "Uploading…" : "Retake for catalog"}
                    hint="A nice shot becomes the display photo"
                    disabled={retakeCatalog.isPending}
                    onClick={() => {
                      close();
                      setCaptureSheet("retake");
                    }}
                  />
                  {/* The strip's add-tile only exists once there ARE extras, so
                      the first photo has to be addable from here. */}
                  <MenuItem
                    icon={<ImageIcon size={14} />}
                    label={addPhoto.isPending ? "Uploading…" : "Add a photo"}
                    hint="Another angle or the label, for a better read"
                    disabled={addPhoto.isPending}
                    onClick={() => {
                      close();
                      setCaptureSheet("add");
                    }}
                  />
                  {barcodeIdentified && item.status === "pending" && (
                    <MenuItem
                      icon={<Pencil size={14} />}
                      label="Fix the name…"
                      hint="Wrong product? Renaming also teaches the barcode database"
                      onClick={() => {
                        close();
                        setCorrecting(true);
                      }}
                    />
                  )}
                  {item.status === "pending" && hasLocations && (
                    <MenuItem
                      icon={<MapPin size={14} />}
                      label="Turn into a bin…"
                      hint="This IS a container: make it a location you can scan into"
                      onClick={() => {
                        close();
                        setMakeBinOpen(true);
                      }}
                    />
                  )}
                  {item.status === "pending" && (
                    <>
                      <MenuSep />
                      <MenuHead>Box state</MenuHead>
                      <MenuItem
                        icon={<span className="text-[13px]">📦</span>}
                        label="Empty box"
                        hint="The box is here; the item isn't"
                        state={boxState === "empty-box" ? "on" : undefined}
                        disabled={setBoxState.isPending}
                        onClick={() => {
                          close();
                          setBoxState.mutate(boxState === "empty-box" ? null : "empty-box");
                        }}
                      />
                      <MenuItem
                        icon={<span className="text-[13px]">📦</span>}
                        label="Item in box"
                        hint="Still packaged — the box rides along"
                        state={boxState === "item-in-box" ? "on" : undefined}
                        disabled={setBoxState.isPending}
                        onClick={() => {
                          close();
                          setBoxState.mutate(boxState === "item-in-box" ? null : "item-in-box");
                        }}
                      />
                    </>
                  )}
                </>
              )}
          </HeaderMenu>
          <button
            type="button"
            onClick={() => rerun.mutate(undefined)}
            // Re-run needs SOMETHING to look up again — a barcode, a photo, OR a
            // name (a receipt/note line has only a name; re-running re-does the
            // web/text lookup and can finally fetch a product image). See
            // canRerunLookup — gating on barcode||image alone greyed out receipts.
            disabled={aiWorking || !canRerunLookup(item)}
            className="text-faint hover:text-accent p-1.5 disabled:opacity-30"
            title={replayNoAi ? "Replaying…" : aiWorking ? "AI is working…" : "Rerun lookup"}
          >
            <RotateCcw size={14} className={aiWorking ? "animate-spin text-accent" : ""} />
          </button>
          {!planContext && (
            <button
              type="button"
              onClick={() => discard.mutate()}
              disabled={discard.isPending}
              className="text-faint hover:text-ember-500 p-1.5 disabled:opacity-30"
              title="Discard (recoverable from Recently deleted)"
            >
              <X size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={() => (planContext && onCollapse ? onCollapse() : expanded ? setExpanded(false) : expandOnly())}
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

      <CameraCaptureSheet
        open={captureSheet !== null}
        title={captureSheet === "retake" ? "Retake catalog photo" : "Add a photo"}
        busy={retakeCatalog.isPending || addPhoto.isPending}
        // A picture CHOSEN from the device is attached, never promoted to the
        // display image, whichever door opened the sheet. A capture is a photo
        // of the object in front of you; a file off the camera roll is
        // routinely a listing screenshot or a spec sheet, and quietly making
        // one the item's face is worse than asking. The gallery's make-primary
        // is one tap away when it really is the picture you want.
        onCapture={(blob, opts) => {
          // The file's TYPE routes it, the same rule the inbox door states: a
          // PDF or CSV is only ever a receipt, so it goes to the parser and
          // becomes this item's purchase. Everything else is a picture.
          const f = blob instanceof File ? blob : null;
          const isReceiptDoc =
            !!f && (f.type === "application/pdf" || f.type === "text/csv" || /\.(pdf|csv)$/i.test(f.name));
          if (isReceiptDoc && f) return attachReceipt.mutate(f);
          return opts?.uploaded
            ? addPhoto.mutate({ blob, uploaded: true })
            : captureSheet === "retake"
              ? retakeCatalog.mutate(blob)
              : addPhoto.mutate(blob);
        }}
        onClose={() => setCaptureSheet(null)}
      />
      {makeBinOpen && (
        <MakeBinSheet
          item={item}
          onClose={() => setMakeBinOpen(false)}
          onArmBin={onArmBin}
        />
      )}
      {/* The seam: the bottom edge of the closed strip. A control opened from a
          chip in that strip belongs here, against the line, not at the far end
          of the card. Empty until something opens. */}
      <div ref={setLocSlot} className="empty:hidden" />
      {/* ── expanded triage surface — photos left, intel right (lg+) ── */}
      {expanded && (
        <div className="border-t border-line dark:border-slate-800 p-3 space-y-3 bg-subtle/40 dark:bg-slate-950/40">
          {/* "Already tracked" — attach to the existing entity
              instead of creating a duplicate. Lazy: only queried on expand. */}
          {item.status === "pending" && (
            <TrackedMatchBanner item={item} locationId={item.target_location_id} />
          )}
          <div className="grid lg:grid-cols-2 gap-3 items-stretch">
          <div className="space-y-2 min-w-0 flex flex-col">
          {/* Catalog vs YOUR photo, side by side (whichever exist). The catalog
              caption says when it is still being checked — it used to read a
              confident "✦ catalog" during the exact window the thumbnail above
              deliberately refuses to show it. */}
          {(catalogImg || yoursImg) && (
            <div className="flex gap-2">
              {catalogImg && (
                <figure className="flex-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => openZoom("catalog")}
                    title="View full size"
                    className="block w-full rounded-md overflow-hidden border border-line dark:border-slate-700 bg-white dark:bg-slate-800 flex items-center justify-center cursor-zoom-in"
                  >
                    {/* A SQUARE frame charged every photo the same height. A
                        landscape shot then sat in a band of empty black that was
                        pure wasted vertical space, while a portrait one used the
                        room it was given (reported 2026-08-10). Filling the
                        width and capping the height lets each photo take only
                        the height it needs: landscape gets short, portrait stays
                        tall and letterboxes sideways, which is the harmless
                        direction.
                        The cap has to BIND, though. These panes size by width,
                        so at a 209px column a 3:4 phone photo is 278px tall next
                        to a 156px landscape catalog shot - and the row inherits
                        the taller one. 20rem was above every height the layout
                        can produce, so it never applied and the pair looked
                        broken rather than comparable (reported 2026-08-11).
                        e2e/scan-card-photo-height.mjs holds the row to a budget
                        with a deliberately mismatched pair. */}
                    <img src={catalogImg} alt="catalog" className="w-full max-h-32 sm:max-h-48 object-contain" onError={() => markBroken(catalogUrl)} />
                  </button>
                  {/* A photo's controls live ON the photo (its caption), not in
                      a standing ambient row — see scan-inbox-ux-review.md F2. */}
                  <figcaption
                    className={
                      "text-[10px] font-mono uppercase tracking-widest mt-1 flex items-center gap-2 " +
                      (unverified ? "text-amber-600 dark:text-amber-400" : "text-accent")
                    }
                  >
                    <span>{unverified ? "✦ catalog - checking" : "✦ catalog"}</span>
                    {hasOrigCatalog && (
                      <button
                        type="button"
                        disabled={catalogAction.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          catalogAction.mutate("revert");
                        }}
                        title={catalogUndoTitle(catalogHistory)}
                        className="normal-case tracking-normal font-sans text-muted hover:text-content underline decoration-dotted underline-offset-2 transition disabled:opacity-50 inline-flex items-center gap-1"
                      >
                        {/* A real icon, not a unicode rotate glyph baked into
                            the label. A symbol used as an icon renders
                            differently on every platform and font, which is how
                            it ends up looking like a stray foreign character
                            rather than a control. */}
                        <RotateCcw size={11} className="shrink-0" />
                        {undoLabel}
                      </button>
                    )}
                  </figcaption>
                </figure>
              )}
              {yoursImg && yoursImg !== catalogImg && (
                <figure className="flex-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => openZoom("yours")}
                    title="View full size"
                    className="block w-full rounded-md overflow-hidden border border-line dark:border-slate-700 bg-black flex items-center justify-center cursor-zoom-in"
                  >
                    <img src={yoursImg} alt="your photo" className="w-full max-h-32 sm:max-h-48 object-contain" onError={() => markBroken(yoursRawUrl)} />
                  </button>
                  <figcaption className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mt-1 flex items-center gap-2">
                    <span>yours</span>
                    {item.image_file_id && (
                      <button
                        type="button"
                        disabled={rotate.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          rotate.mutate();
                        }}
                        title="Rotate your photo 90°"
                        className="normal-case tracking-normal font-sans hover:text-content underline decoration-dotted underline-offset-2 transition disabled:opacity-50"
                      >
                        {rotate.isPending ? "rotating…" : "⟳ rotate"}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={catalogAction.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        catalogAction.mutate("use_own_photo");
                      }}
                      title="Use this photo as the catalog/display image"
                      className="normal-case tracking-normal font-sans hover:text-content underline decoration-dotted underline-offset-2 transition disabled:opacity-50"
                    >
                      use as catalog
                    </button>
                  </figcaption>
                </figure>
              )}
            </div>
          )}
          {/* Extra photos (multi-photo gallery): tap → make primary; × → remove.
              Renders ONLY when there are extras, so the photo-options strip sits
              directly under the big images: a strip holding nothing but its own
              add-tile spent a whole row saying nothing (reported 2026-08-11).
              Adding a photo lives in the ⋯ menu when the strip is absent. */}
          {zoomIdx !== null && zoomItems[zoomIdx] && (
            <ImageLightbox
              searchSlot={
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setPhotoTerm(zoomTerm.trim());
                  }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    value={zoomTerm}
                    onChange={(e) => {
                      zoomTermTouched.current = true;
                      setZoomTerm(e.target.value);
                    }}
                    placeholder="search images…"
                    className="flex-1 min-w-0 rounded border border-white/20 bg-white/10 px-2 py-1 text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-white/40"
                  />
                  <button
                    type="submit"
                    className="shrink-0 rounded border border-white/20 px-2 py-1 text-[11px] font-medium text-white/80 hover:text-white hover:border-white/40"
                  >
                    Search
                  </button>
                  {(photoTerm || zoomTermTouched.current) && (
                    <button
                      type="button"
                      onClick={() => {
                        zoomTermTouched.current = false;
                        setPhotoTerm("");
                      }}
                      className="shrink-0 rounded px-2 py-1 text-[11px] text-white/50 hover:text-white/80"
                      title="Back to the automatic search"
                    >
                      Reset
                    </button>
                  )}
                </form>
              }
              items={zoomItems}
              index={zoomIdx}
              onIndex={setZoomIdx}
              onClose={() => setZoomIdx(null)}
              action={{
                // Zooming YOUR photo is exactly when you decide it beats the
                // catalog shot, so the adopt action belongs here too — the card's
                // small caption button is not where you are looking at that
                // moment (reported 2026-08-11). The catalog image itself stays
                // action-less: it is already the catalog image.
                label: (it) =>
                  it.key === "catalog"
                    ? null
                    : it.key === "yours" || it.key === "crop"
                      ? "Use as catalog"
                      : "Use this image",
                busy: pickCatalogImage.isPending || catalogAction.isPending,
                onAction: (it) => {
                  if (it.key === "yours") catalogAction.mutate("use_own_photo");
                  else if (it.key === "crop") catalogAction.mutate("use_screenshot_crop");
                  else if (it.url) pickCatalogImage.mutate(it.url);
                  setZoomIdx(null);
                },
              }}
            />
          )}
          </div>
          <div className="min-w-0 flex flex-col gap-2">

          {/* The AI's read — collapsed to its one-line header by default
              tap to reveal the reconciliation paragraph + per-field
              chips. The working pulse lives in the always-visible header. */}
          {(item.ai_notes || item.ai_confidence || topCand || aiWorking) && (
            <div className="rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 px-3 py-2">
              <button
                type="button"
                onClick={() => setAiOpen((o) => !o)}
                aria-expanded={aiOpen}
                className="w-full text-left text-xs font-medium text-content dark:text-mortar-100 flex items-center gap-1.5"
              >
                {replayNoAi ? (
                  <RefreshCw size={12} className="text-accent animate-spin" />
                ) : (
                  <Sparkles size={12} className={aiWorking ? "text-accent animate-pulse" : "text-accent"} />
                )}
                {aiWorking ? (
                  <span className="animate-pulse">
                    {rerun.isPending ? "Re-running the lookup…" : "AI is reading the details…"}
                  </span>
                ) : (
                  "Source data"
                )}
                {!aiWorking && item.ai_confidence && (
                  <span className="text-muted">· {item.ai_confidence}</span>
                )}
                {!aiWorking && item.updated_at && (
                  <span className="text-faint">· updated {timeAgo(item.updated_at)}</span>
                )}
                <ChevronDown
                  size={13}
                  className={`ml-auto text-faint transition-transform ${aiOpen ? "rotate-180" : ""}`}
                />
              </button>
              {aiOpen && (<>
              {/* A warning already reads in amber above; repeating it here in
                  muted body text says it twice and says it quieter. */}
              {notesPlacement.sourceBox && (
                <p className="text-xs text-muted dark:text-slate-400 mt-1">{item.ai_notes}</p>
              )}
              {/* A re-run is a gamble you can LOSE: vision re-read a dark photo of
                  a tool tote as a "Portable Bluetooth Speaker" and the good name
                  was gone, recoverable only by hand-reading the raw AI call log
                  (reported 2026-07-17). The run snapshots what it's about to
                  overwrite, so the way back is one tap. Shown only while a
                  snapshot exists — the next run replaces it, and undoing clears it. */}
              {(() => {
                const snap = (
                  item.suggested_metadata as { pre_rerun?: { name?: string | null; kind?: string } } | null
                )?.pre_rerun;
                if (!snap || item.status !== "pending") return null;
                return (
                  // ONE LINE, no panel. A bordered, tinted box with its own
                  // padding spent roughly 70px on a sentence and a button, and
                  // the sentence wrapped so the button fell below it. The amber
                  // stays on the control, which is the part that acts.
                  <div className="mt-1.5 flex items-center gap-2 min-w-0">
                    <span className="min-w-0 truncate text-[11px] text-muted dark:text-slate-400">
                      {snap.name ? (
                        <>
                          {/* The NAME is the thing you are deciding about, so the
                              label gets out of its way. Which mechanism replaced
                              it (replay vs re-run) is in the history below and
                              does not need saying twice, and "revert" is not
                              repeated because the button beside it says so. */}
                          Previously:{" "}
                          <span className="font-medium text-content dark:text-mortar-100">{snap.name}</span>
                        </>
                      ) : (
                        <>This {snap.kind === "replay" ? "replay" : "re-run"} replaced the previous answer</>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => undoRerun.mutate()}
                      disabled={undoRerun.isPending}
                      className="shrink-0 inline-flex items-center gap-1 rounded-full border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-300 hover:bg-amber-100/70 dark:hover:bg-amber-900/30 px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-50"
                    >
                      <RotateCcw size={11} className={undoRerun.isPending ? "animate-spin" : ""} />
                      {undoRerun.isPending ? "Reverting…" : "Revert"}
                    </button>
                  </div>
                );
              })()}
              {/* Per-item history — what you did to this listing, newest first.
                  ("You asked for more detail · 2 min ago".) */}
              {(() => {
                const hist = (
                  item.suggested_metadata as { history?: { action: string; at: string; note?: string }[] } | null
                )?.history;
                if (!Array.isArray(hist) || hist.length === 0) return null;
                const label: Record<string, string> = {
                  rerun: "Re-ran the lookup with AI",
                  replay: "Replayed: the latest processing, same identification",
                  "rerun-hint": "Re-ran with a hint",
                  barcode: "Corrected the barcode",
                  wrong: "Flagged wrong — re-checked everything",
                  enrich: "Asked for more detail",
                  confirm: "Locked into the barcode database",
                  combine: "Combined similar items",
                  "undo-rerun": "Undid the re-run",
                };
                // "Re-ran the lookup with AI" is written when the run STARTS,
                // so on its own it claims something the run may never have
                // delivered - the monitor-label item read exactly that for a run
                // the AI never answered (reported 2026-08-10). The row stamps
                // whether a model answered the LATEST run; the newest entry IS
                // that run, so the outcome is reported there and nowhere else.
                // Only for actions that ASK the AI - a replay is no-AI by design.

                return (
                  <div className="mt-2 border-t border-line dark:border-slate-700/60 pt-1.5">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">history</div>
                    {/* The LIST scrolls, the card does not grow. Nothing is
                        dropped: an unbounded history is what makes this rail
                        tall, and the rail's height is the card's height.
                        Newest first, so the useful end needs no scrolling. */}
                    <ul className="space-y-0.5 max-h-20 overflow-y-auto pr-1">
                      {[...hist].reverse().map((h, i) => {
                        // The verdict rides on the ENTRY, so it stays with the
                        // run it describes instead of hopping to whatever is
                        // newest (reported 2026-08-10).
                        const noAnswer = (h as { ai_answered?: boolean }).ai_answered === false;
                        return (
                        <li key={i} className="text-[11px] text-muted dark:text-slate-400 flex items-baseline gap-2">
                          <span className="min-w-0">
                            {label[h.action] ?? h.action}
                            {noAnswer && (
                              <span className="text-amber-600 dark:text-amber-400"> - the AI didn’t answer</span>
                            )}
                            {h.note ? `: “${h.note}”` : ""}
                          </span>
                          <span className="text-faint ml-auto whitespace-nowrap">{timeAgo(h.at)}</span>
                        </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })()}
              {/* The actual data the lookup returned — every parsed field, so it's
                  visible even when the form has no box for it, plus the raw dump. */}
              {(() => {
                const fields = parsedScanFields(item.suggested_metadata as Record<string, unknown> | null);
                const entries = Object.entries(fields).filter(([, v]) => v != null && v !== "");
                if (entries.length === 0) return null;
                return (
                  <div className="mt-1.5">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Parsed fields</div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      {entries.map(([k, v]) => {
                        const sw = /colou?r/i.test(k) ? colorSwatch(v) : null;
                        return (
                        <div key={k} className="flex items-baseline gap-1.5 text-[11px] min-w-0">
                          {sw && <span className="h-2.5 w-2.5 self-center shrink-0 rounded-full border border-line dark:border-slate-600" style={{ background: sw }} />}
                          <span className="shrink-0 text-faint">{humanizeKey(k)}</span>
                          <span className="truncate font-medium text-content dark:text-mortar-200">{String(v)}</span>
                        </div>
                        );
                      })}
                    </div>
                    <details className="mt-1.5">
                      <summary className="cursor-pointer select-none text-[10px] text-faint hover:text-muted">raw response</summary>
                      <pre className="mt-1 overflow-x-auto rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2 text-[10px] leading-snug text-content dark:text-mortar-200">
{JSON.stringify(item.suggested_metadata, null, 2)}
                      </pre>
                    </details>
                  </div>
                );
              })()}
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
              {/* Audit links live with the provenance they audit — they were an
                  everyday-looking row of the identity strip (review F6). */}
              {(item.barcode_text || item.suggested_name) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
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
              )}
              </>)}
            </div>
          )}

          {/* Research hint — re-run, confirm it's GOOD (lock into the barcode
              DB), flag WRONG (re-derive), or ask for more DETAIL (keep product,
              fill it in). */}
          <HintBox
            onSubmit={(h, opts) => rerun.mutate({ hint: h || undefined, ...opts })}
            busy={aiWorking}
            busyKind={aiWorking ? (replayNoAi ? "replay" : "ai") : null}
            hasBarcode={!!item.barcode_text}
            onConfirm={() => confirmBarcode.mutate()}
            confirming={confirmBarcode.isPending}
            // Only when the status has LOADED and says no. A null status means
            // "not answered yet", and greying a working button during that
            // window is worse than the button being live for a moment.
            aiOff={cardAiStatus ? !cardAiStatus.available : false}
            rowLeading={
              <>
              {editingBarcode ? (
                <span className="inline-flex items-center gap-1 font-mono" onClick={(e) => e.stopPropagation()}>
                  ▌▌
                  <input
                    autoFocus
                    inputMode="numeric"
                    value={barcodeDraft}
                    onChange={(e) => setBarcodeDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveBarcode();
                      else if (e.key === "Escape") setEditingBarcode(false);
                    }}
                    placeholder="digits from the label"
                    className="w-36 rounded border border-accent bg-surface dark:bg-slate-900 px-1.5 py-0.5 font-mono text-content outline-none"
                  />
                  <button
                    type="button"
                    disabled={rerun.isPending || !barcodeDraftValid}
                    onClick={saveBarcode}
                    className="rounded bg-cobble-600 hover:bg-cobble-700 px-2 py-0.5 text-[11px] font-medium text-white transition disabled:opacity-50"
                  >
                    {rerun.isPending ? "Looking up…" : "Save & re-run"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingBarcode(false)}
                    className="text-faint hover:text-content"
                    aria-label="Cancel barcode edit"
                  >
                    <X size={12} />
                  </button>
                </span>
              ) : item.barcode_text ? (
                <span className="inline-flex items-center gap-1 font-mono text-content dark:text-mortar-200 bg-subtle dark:bg-slate-800 rounded px-2 py-0.5">
                  ▌▌{item.barcode_text}
                  {item.status === "pending" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setBarcodeDraft(item.barcode_text ?? "");
                        setEditingBarcode(true);
                      }}
                      title="Fix the barcode - saving re-runs the lookup on the corrected code"
                      aria-label="Edit the barcode"
                      className="text-faint hover:text-accent transition"
                    >
                      <Pencil size={11} />
                    </button>
                  )}
                </span>
              ) : item.status === "pending" ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setBarcodeDraft("");
                    setEditingBarcode(true);
                  }}
                  title="Type the barcode off the label - it identifies the product exactly"
                  className="inline-flex items-center gap-1 font-mono text-muted dark:text-slate-400 border border-dashed border-line dark:border-slate-700 rounded px-2 py-0.5 hover:border-accent hover:text-content transition"
                >
                  ▌▌ Add barcode
                </button>
              ) : null}
              </>
            }
            rowTrailing={
              <>
              {flaggedForReview && (
                <button
                  type="button"
                  disabled={markReviewed.isPending}
                  onClick={(e) => {
                    e.stopPropagation();
                    markReviewed.mutate();
                  }}
                  title="A human looked - this one's fine; stop flagging it"
                  className="inline-flex items-center gap-1 rounded border border-emerald-400/60 px-2 py-0.5 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition disabled:opacity-50"
                >
                  ✓ Looks fine
                </button>
              )}
              </>
            }
          />
          {/* Identity row: barcode + area + sanity-check links. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {/* The barcode is EDITABLE while pending. The camera/vision can read
                a digit wrong, and before this the row was display-only: the one
                field a "correct barcode X" correction was about was the one
                field it couldn't reach, so every re-run faithfully re-resolved
                the misread code (reported 2026-08-03). Saving re-runs the lookup on
                the corrected code. */}
            {item.scan_area && (
              <span className="inline-flex items-center gap-1 text-muted dark:text-slate-400">
                <MapPin size={11} className="text-accent" /> {item.scan_area}
              </span>
            )}
            {/* Suggested home from where similar items live — one-tap accept.
                Only when we have a suggestion and the user hasn't filed it yet. */}
            {item.suggested_location_id && !item.target_location_id && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-moss-500/10 text-moss-700 dark:text-moss-400 px-2 py-0.5">
                <MapPin size={11} /> Suggested: {item.suggested_location_note ?? "a spot"}
                <button
                  type="button"
                  onClick={() => acceptSuggestedLocation.mutate()}
                  disabled={acceptSuggestedLocation.isPending}
                  className="ml-0.5 rounded bg-moss-600 hover:bg-moss-700 text-white px-1.5 py-0.5 text-[10px] transition disabled:opacity-50"
                >
                  {acceptSuggestedLocation.isPending ? "…" : "Put here"}
                </button>
              </span>
            )}
          </div>

          </div>
          </div>

          {/* The strip and the commit controls are a FULL-WIDTH row under
              both columns. The strip used to sit in the photo column and
              reach right with a negative margin, which was only safe while
              that column happened to be taller than the rail: on an item
              with history and a long note the tiles ran straight under the
              research-hint box. No CSS can know which column is taller, so
              the strip stops borrowing the rail's space. */}
          <div className="flex items-end gap-3 !mt-1.5">
            <div className="flex-1 min-w-0">
            {/* ONE strip: the item's own photos, a divider, then the web
                candidates - all the same tile, all in ONE flex row and ONE
                scroll container, because two adjacent rows with their own
                wrappers and their own tile sizes read as two widgets no matter
                how close together they sit. Its own full-width row under both
                columns, beside the commit stack. */}
            <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
              <PhotoOptions
                item={item}
                onView={openZoomUrl}
                onItems={setPhotoCandidates}
                term={photoTerm}
                onTerm={setPhotoTerm}
                onSearched={setPhotoSearched}
                compact
                // No add button here. It widened the strip's first column for a
                // job the card's camera menu ("Add a photo") already does, and
                // that width is exactly what the tiles want.
                leadingLabel={
                  <span className="text-xs font-medium text-content shrink-0">Your photos</span>
                }
                leading={
                  <>
                    {extraPhotos.map((pid) => (
                      <ExtraPhotoThumb
                        key={pid}
                        slug={activeSlug}
                        fileId={pid}
                        onMakePrimary={() => setPrimaryPhoto.mutate(pid)}
                        onRemove={() => removeExtraPhoto.mutate(pid)}
                        onReidentify={
                          item.status === "pending" ? () => rerun.mutate({ imageFileId: pid }) : undefined
                        }
                        busy={setPrimaryPhoto.isPending || removeExtraPhoto.isPending || rerun.isPending}
                      />
                    ))}
                    {/* just a vertical line */}
                    <div className="w-px self-stretch shrink-0 bg-line dark:bg-slate-700 mx-1.5" />
                  </>
                }
              />
            </div>
            </div>
            <div className="mt-auto flex flex-col gap-2">
              {/* The commit summon sits at the BOTTOM of the intel column, not on a
                  full-width row under the grid: the photo column always runs taller,
                  so that row was buying nothing but height (reported 2026-08-08).
                  Below `lg` the grid is one column, so this still lands last. */}
              {!planContext && !formOpen && (
                <div className="flex justify-end">
                  <div className="flex flex-col items-end gap-1">
                  {/* This is the ONE door into the fields: it opens the form on
                      the table CHOSEN in the header pill (not the matchmaker's
                      top guess - picking Assets up there and getting an
                      Inventory form down here was a real bug). "add somewhere
                      else…" is gone: the pill's picker lists every table, which
                      is the whole of what that link used to do. */}
                  <button
                    type="button"
                    onClick={() => openForm(dest ?? undefined)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-xs font-semibold transition"
                  >
                    {dest && !isUnidentified(item.suggested_name)
                      ? `Add to ${dest.label}…`
                      : "Add to a table…"}
                  </button>
                  </div>
                </div>
              )}
                {formOpen && <div ref={setActionSlot} className="flex justify-end" />}
                {!formOpen && (
                  <div className="flex justify-end">
                  {/* Close from where you FINISHED reading. The only collapse used to
                      be the chevron in the top rail, so getting out of a long card
                      meant scrolling back up past everything you had just read. */}
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    aria-label="Collapse this item"
                    title="Collapse"
                    className="shrink-0 rounded-md border border-line dark:border-slate-700 p-1.5 text-faint hover:text-accent hover:border-accent transition"
                    >
                    <ChevronDown size={14} className="rotate-180" />
                  </button>
                </div>
                )}
            </div>
          </div>


          {/* The inline confirm form — full width below (the right-rail
              attempt collided labels at every width; reverted per the author).
              NEVER in plan context: committing mid-plan removes the item from
              the plan — fixing identity is the only job here.
              SUMMONED, not ambient (review F1): a plain expand shows the summon
              row; the form renders once a destination is picked. */}
          {!planContext && formOpen && <ConfirmForm
            key={`${item.id}:${formCtx.selKey ?? "auto"}:${item.suggested_name ?? ""}:${item.suggested_manufacturer ?? ""}:${item.ai_suggested_at ?? ""}:${topCand ? topCand.label + JSON.stringify(topCand.fields) + (topCand.quantity ?? "") : "none"}`}
            item={item}
            menu={menu}
            candidates={candidates}
            hasLocations={hasLocations}
            initialKey={formCtx.selKey}
            prefill={formCtx.prefill}
            onDone={() => {
              setFormOpen(false);
              setExpanded(false);
            }}
            // Cancel undoes the EDIT, not your place. It used to be identical to
            // onDone - close the form AND collapse the card - so cancelling an edit
            // slammed the accordion shut and landed you on the closed row's
            // "Add to Inventory…", which read as the card doing something weird
            // rather than as your edit being discarded. Now: the chips go back to
            // read-only, and you are still looking at the card you opened.
            onCancel={() => setFormOpen(false)}
            onCollapse={() => setExpanded(false)}
            actionSlot={actionSlot}
            fieldSlot={fieldSlot}
            locSlot={locSlot}
          />}
        </div>
      )}
    </div>
  );
}

// ── gallery view tile: big photo + name + status ring; tap = triage ──
function GalleryTile({
  item,
  slug,
  onOpen,
}: {
  item: ScanInboxItem;
  slug: string;
  onOpen: () => void;
}) {
  const raw = leadPhoto(item, {
    catalog: [
      item.catalog_image_file_id
        ? `/api/v1/orgs/${slug}/modules/core-files/files/${item.catalog_image_file_id}/raw?variant=med`
        : null,
      item.catalog_image_url ?? null,
    ],
    yours: item.image_file_id
      ? `/api/v1/orgs/${slug}/modules/core-files/files/${item.image_file_id}/raw?variant=med`
      : null,
  }).src;
  const src = useImageSrc(raw);
  // The amber tile border marks the same thing the header's "to review" count
  // does, so it asks the shared predicate rather than re-deriving it. Its own
  // copy had already drifted: it kept flagging an item a human had marked "looks
  // fine", and stayed quiet on a low-confidence identification.
  const flagged = needsScanReview(item);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative rounded-lg overflow-hidden border text-left aspect-square bg-subtle dark:bg-slate-800 ${
        flagged ? "border-amber-400/70" : "border-line dark:border-slate-700"
      }`}
    >
      {src ? (
        <img src={src} alt="" className="w-full h-full object-cover" loading="lazy" />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <ScanLine size={22} className="text-faint" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pt-6 pb-1.5">
        <div className="text-[11px] leading-tight text-white line-clamp-2">
          {item.suggested_name ?? <span className="italic text-white/70">unidentified</span>}
        </div>
        {(item.quantity ?? 1) > 1 && <div className="text-[10px] text-white/80">×{item.quantity}</div>}
      </div>
      {flagged && <span className="absolute top-1 right-1 text-[11px]">⚠</span>}
    </button>
  );
}

// ── extra-photo thumb (multi-photo gallery): tap = primary, × = remove ─
function ExtraPhotoThumb({
  slug,
  fileId,
  onMakePrimary,
  onRemove,
  onReidentify,
  busy,
}: {
  slug: string;
  fileId: string;
  onMakePrimary: () => void;
  onRemove: () => void;
  /** Re-run the identify FROM this photo. Present only while pending. */
  onReidentify?: () => void;
  busy: boolean;
}) {
  const src = useImageSrc(`/api/v1/orgs/${slug}/modules/core-files/files/${fileId}/raw?variant=thumb`);
  return (
    <div className="relative w-20 h-20 shrink-0">
      <button
        type="button"
        disabled={busy}
        onClick={onMakePrimary}
        title="Make this the primary photo"
        className="w-20 h-20 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-black flex items-center justify-center disabled:opacity-50"
      >
        {/* CONTAIN: this tile is how you decide WHICH of your photos should
            lead, so it has to show the whole shot rather than its middle. */}
        {src ? <img src={src} alt="" className="w-full h-full object-contain" /> : <ImageIcon size={16} className="text-faint" />}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onRemove}
        title="Remove this photo"
        className="absolute top-1 right-1 rounded bg-black/60 hover:bg-ember-600 text-white shadow-md w-6 h-6 flex items-center justify-center disabled:opacity-50"
      >
        <X size={13} strokeWidth={2.5} />
      </button>
      {onReidentify && (
        <button
          type="button"
          disabled={busy}
          onClick={onReidentify}
          title="Re-identify the item from this photo"
          aria-label="Re-identify from this photo"
          className="absolute bottom-1 right-1 rounded bg-black/60 hover:bg-cobble-600 text-white shadow-md w-6 h-6 flex items-center justify-center disabled:opacity-50"
        >
          <RotateCcw size={13} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}

// ── photo options: DDG alternatives for the catalog image ────────────
// The "OTHER PHOTO OPTIONS" strip. Lazy — only fetches once a card
// is expanded; picking one downloads it into core-files as the catalog
// image (SSRF-guarded server-side).
function PhotoOptions({
  item,
  onView,
  onItems,
  term,
  onTerm,
  onSearched,
  compact,
  leading,
  leadingLabel,
}: {
  item: ScanInboxItem;
  /** A tile's ⤢ opens the CALLER's full-screen viewer at this candidate (the
   *  scan card's ONE lightbox: catalog + yours + these candidates), instead of
   *  the picker's own viewer. */
  onView?: (url: string) => void;
  /** Report the fetched candidates up so the caller can fold them into its own
   *  filmstrip. */
  onItems?: (items: ImageOption[]) => void;
  /** The applied search term, owned by the caller so the SAME search can be
   *  driven from here or from the full-screen viewer. Uncontrolled when
   *  omitted. */
  term?: string;
  onTerm?: (t: string) => void;
  /** What the server actually searched for, reported up so a caller's own box
   *  can prefill with it rather than hiding it behind a placeholder. */
  onSearched?: (q: string) => void;
  /** Strip layout: one header line then the tiles, for sitting beside the
   *  item's own photo strip as a single row. */
  compact?: boolean;
  /** Rendered inside the tile row before the web candidates - the item's own
   *  photos and the divider, so the pair is one row. */
  leading?: ReactNode;
  leadingLabel?: ReactNode;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  // The term box itself lives in the shared ImageSearchPicker; it hands the
  // typed term back via onSearch and we re-run the item's own ranked query
  // with it (the server treats a user term as an outright override).
  const [ownApplied, setOwnApplied] = useState("");
  const applied = term ?? ownApplied;
  const setApplied = (t: string) => (onTerm ? onTerm(t) : setOwnApplied(t));
  const options = useQuery({
    // ai_suggested_at is in the key on purpose: a re-run can change the NAME and
    // the resolved COLOUR, which changes the search phrase — but the old key was
    // just (item, term) with a 5 minute staleTime, so the strip kept serving the
    // photos from BEFORE the re-run. Hinting "color: blue" then looked like it
    // did nothing (reported 2026-07-30).
    // Keyed on the NAME, not just ai_suggested_at: the matchmaker can adopt a
    // better name without re-stamping ai_suggested_at, so a re-identify that
    // renamed the item left the strip searching the OLD title until a reload
    // (reported 2026-08-10). The name IS the search phrase, so it belongs in
    // the key of the query that searches by it.
    queryKey: [
      "scan-photo-options",
      activeSlug,
      item.id,
      applied,
      item.suggested_name ?? "",
      item.suggested_manufacturer ?? "",
      item.ai_suggested_at ?? "",
    ],
    queryFn: () => api.scanPhotoOptions(activeSlug, item.id, applied || undefined),
    // Only when there's a REAL name to search by — an unidentified item ("Unknown
    // Item") or a bare barcode returns junk photos, so don't even ask.
    enabled: !isUnidentified(item.suggested_name),
    staleTime: 5 * 60_000,
  });
  const pick = useMutation({
    mutationFn: (p: string | { url: string; aiPick?: boolean }) => {
      const url = typeof p === "string" ? p : p.url;
      return api.setScanCatalogImage(activeSlug, item.id, url, {
        ...(typeof p === "string" ? {} : { aiPick: p.aiPick }),
        thumbUrl: (options.data?.items ?? []).find((o) => o.url === url)?.thumb,
      });
    },
    onSuccess: () => {
      toast.success("Catalog photo updated");
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // "✨ Pick best (AI)": a vision model ranks the options for the product-only,
  // correct-colour, no-people shot; on a pick we highlight its tile, show the
  // reason, and APPLY it as the catalog image in one press (the user can still
  // tap another). A null pick (no name / no provider) just surfaces the reason.
  // The DISPLAYED candidates + the applied term ride along, so the model ranks
  // exactly the tiles on screen (the ✨ badge always lands on a visible one) and
  // a second, nondeterministic search can't hand it a different pool.
  const [bestUrl, setBestUrl] = useState<string | null>(null);
  const [bestReason, setBestReason] = useState<string | null>(null);
  const pickBest = useMutation({
    mutationFn: () =>
      api.rankScanPhotoAi(activeSlug, item.id, {
        q: applied || undefined,
        candidates: options.data?.items ?? [],
      }),
    onSuccess: (r) => {
      if (r.chosen_url) {
        setBestUrl(r.chosen_url);
        setBestReason(r.reason || null);
        // Flagged as the AI's pick so Revert comes back HERE, not to the first
        // web result that this same apply stashes as the original.
        pick.mutate({ url: r.chosen_url, aiPick: true });
      } else {
        setBestUrl(null);
        setBestReason(r.reason || null);
        toast.info(r.reason || "AI couldn't pick a photo.");
      }
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Report the fetched candidates up so the card's ONE lightbox can fold them
  // into its filmstrip (open from the catalog image → see the web options too).
  useEffect(() => {
    onItems?.(options.data?.items ?? []);
    // What the server actually searched, so a caller's own box can PREFILL with
    // it. A blank box behind a placeholder hides the one thing you need to know
    // in order to change it.
    onSearched?.(options.data?.query ?? "");
  }, [options.data, onItems, onSearched]);
  // The search box, the grid, broken-thumb handling and the full-size preview
  // all live in the shared ImageSearchPicker now — this used to carry its own
  // copy of the box, which is exactly how the surfaces drifted apart. What
  // stays here is scan-specific: the item's own ranked pipeline
  // (scanPhotoOptions) and applying the pick as the CATALOG image.
  return (
    <ImageSearchPicker
      items={options.data?.items ?? []}
      loading={options.isLoading}
      busy={pick.isPending}
      searchedTerm={options.data?.query ?? null}
      onSearch={(t) => {
        // A new search replaces the pool — a badge/reason about the OLD pool
        // would point at a tile that may no longer exist.
        setBestUrl(null);
        setBestReason(null);
        setApplied(t);
      }}
      onPick={(url) => pick.mutate(url)}
      onPreview={onView}
      label={applied ? `results for "${applied}"` : "find a better catalog photo"}
      onPickBest={() => pickBest.mutate()}
      pickingBest={pickBest.isPending}
      bestUrl={bestUrl}
      bestReason={bestReason}
      compact={compact}
      leading={leading}
      leadingLabel={leadingLabel}
    />
  );
}

// ── research hint: tell the AI what it got wrong, re-run with it ─────
function HintBox({
  onSubmit,
  busy,
  busyKind,
  hasBarcode,
  onConfirm,
  confirming,
  rowLeading,
  rowTrailing,
  aiOff = false,
}: {
  onSubmit: (hint: string, opts: { wrong?: boolean; enrich?: boolean; noAi?: boolean }) => void;
  /** The workspace has NO AI provider. Every control here that calls a model is
   *  then a button that cannot do its job, and pressing it teaches nothing: the
   *  scan silently falls back to the keyword floor and the card looks unchanged.
   *  Say so on the control instead. Replay is exempt - it is noAi by design. */
  aiOff?: boolean;
  busy: boolean;
  /** WHICH action is in flight — only that button's icon animates ("both
   *  spinners going" made a free replay read as an AI call). */
  busyKind?: "replay" | "ai" | null;
  hasBarcode: boolean;
  onConfirm: () => void;
  confirming: boolean;
  /** Controls that share the action row rather than each taking a row of their
   *  own. The barcode chip and the review-state toggle used to sit on separate
   *  lines above this box; folding them in here is pure height back. */
  rowLeading?: ReactNode;
  /** Controls that sit WITH Replay / Re-run rather than at the barcode end.
   *  Position is the only thing telling you what a control acts on, and
   *  "Looks fine" judges the identification, not the barcode it sat beside. */
  rowTrailing?: ReactNode;
}) {
  const [hint, setHint] = useState("");
  // The three correction buttons below all write to the SHARED, cross-workspace
  // Barcode Intelligence DB (a wrong/enrich correction, or a green verify) — so a
  // scan in one workspace teaches every other workspace's future scans of that
  // UPC. Curating that shared DB is the platform operator's call, not every
  // member's: a well-meaning member "locking in" a mislabelled listing poisons it
  // for everyone. So the trio is operator-only. Members keep the research-hint +
  // Re-run AI above, which only re-resolves THEIR OWN item (workspace-scoped
  // cache), never the shared DB.
  const { user } = useAuth();
  const canCurateBarcodeDb = !!user?.is_platform_admin;
  const fire = (opts: { wrong?: boolean; enrich?: boolean; noAi?: boolean }) => {
    onSubmit(hint.trim(), opts);
    setHint("");
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // The hint is OPTIONAL — submitting empty re-runs the AI as-is (matches
        // the inline re-run); with a hint it re-runs with that extra context.
        if (aiOff) return;
        fire({});
      }}
      className="rounded-md border border-dashed border-line dark:border-slate-700 p-1.5"
    >
      {/* No caption row. It spent a line naming the box, which the box's own
          placeholder already does. Full-width textarea (a single-line input cut
          the placeholder off): Enter submits, Shift+Enter inserts a newline. */}
      <textarea
        value={hint}
        onChange={(e) => setHint(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            fire({});
          }
        }}
        rows={2}
        placeholder="Research hint: a model number, a better name, the correct barcode… (Enter to submit)"
        className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800 resize-none"
      />
      {aiOff && (
        <p className="mt-1 text-[11px] text-muted dark:text-slate-400">
          Re-run needs an AI provider. Replay still re-applies the latest processing.
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        {rowLeading}
        <span className="ml-auto" />
        {rowTrailing}
        {/* Replay — no model call of any kind. It re-runs everything DOWNSTREAM
            of the identification (routing, field mapping, pack size, decoder
            role-fill, the split derivation, category) over the answer already
            stored on this row, so a fix to any of that can be tried on a real
            item instantly and for free. It cannot produce a new identification,
            and by construction it cannot make the item worse. Use Re-run AI for a
            fresh look. Hidden when a hint is typed — a hint is new information,
            which needs a real read. */}
        {!hint.trim() && (
          <button
            type="button"
            disabled={busy}
            onClick={() => fire({ noAi: true })}
            title="Free and instant: re-applies Cobblr's latest processing (routing, fields, pack size) to what the AI already found. It keeps the identification as-is - use Re-run AI for a fresh look."
            className="rounded border border-line dark:border-slate-600 px-2 py-0.5 text-xs text-muted dark:text-slate-300 hover:bg-mortar-50 dark:hover:bg-slate-800 disabled:opacity-50 shrink-0 inline-flex items-center gap-1"
          >
            <RefreshCw size={11} className={busyKind === "replay" ? "animate-spin" : ""} /> Replay
          </button>
        )}
        <button
          type="submit"
          disabled={busy || aiOff}
          title={aiOff ? "Connect an AI provider under Configuration → AI to use this" : undefined}
          className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-0.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed shrink-0 inline-flex items-center gap-1"
        >
          <RotateCcw size={11} className={busyKind === "ai" ? "animate-spin" : ""} /> {hint.trim() ? "Re-run with hint" : "Re-run AI"}
        </button>
      </div>
      {/* Shared-barcode-DB curation — OPERATOR ONLY (see canCurateBarcodeDb).
          Triage in traffic-light order — red → yellow → green:
          • This is wrong — distrust the identity entirely, re-derive from scratch.
          • Right — needs detail — product's right but the listing is thin; keep
            the identity, dig every source + the web for the full name/spec/photo.
          • This is good — verify the current listing into the shared barcode DB.
          The two corrections share a half-width row; the affirmative sits below. */}
      {canCurateBarcodeDb && (
        <>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy || aiOff}
              onClick={() => fire({ wrong: true })}
              title={aiOff ? "Connect an AI provider under Configuration → AI to use this" : "Wrong product - re-check every source + the web, fix the name & photo, and correct the shared barcode database"}
              className="flex-1 min-w-0 rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 px-2 py-1.5 text-sm font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <Flag size={13} className={busy ? "animate-pulse" : ""} /> This is wrong
            </button>
            <button
              type="button"
              disabled={busy || aiOff}
              onClick={() => fire({ enrich: true })}
              title={aiOff ? "Connect an AI provider under Configuration → AI to use this" : "The product is right but the listing is sparse - re-check every source + the web to fill in the proper name, size and photo"}
              className="flex-1 min-w-0 rounded border border-amber-300 dark:border-amber-700/70 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 px-2 py-1.5 text-sm font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <Sparkles size={13} className={busy ? "animate-pulse" : ""} /> Right - needs detail
            </button>
          </div>
          {hasBarcode && (
            <button
              type="button"
              disabled={busy || confirming}
              onClick={onConfirm}
              title="Lock the current name, brand & photo into the shared barcode database as verified"
              className="mt-2 w-full rounded border border-emerald-300 dark:border-emerald-700/70 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 px-3 py-1.5 text-sm font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <CheckCircle size={13} className={confirming ? "animate-pulse" : ""} /> This is good - lock it in
            </button>
          )}
        </>
      )}
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

/** The fields the DESTINATION declares that the matchmaker left empty.
 *
 *  The chip row only ever showed fields with a value, so a table's own
 *  distinctive fields were invisible whenever a scan happened not to fill them
 *  — asked as "where are all the unique fields for 3D Printer, not being
 *  shown?" (2026-08-11). They were never missing, just silent: an empty field
 *  has nothing to render as a chip. Counting them gives the row something
 *  honest to point at without pasting a blank form into a triage view. */
function unfilledFieldLabels(
  menu: ScanMenuEntry[] | null,
  cand: ScanCandidate,
): string[] {
  const entry = (menu ?? []).find(
    (m) => m.module === cand.module && (m.instance ?? null) === (cand.instance ?? null),
  );
  if (!entry) return [];
  const filled = new Set(Object.keys(cand.fields ?? {}).map((k) => k.toLowerCase()));
  return entry.fields
    .filter((f) => !filled.has(f.name.toLowerCase()))
    .map((f) => f.label ?? f.name);
}

/** The `parent` config a bundle puts on a child instance (Spools → Filament
 *  Types): the create/scan flow find-or-creates the parent "type" by
 *  `key_fields` and links the child to it. Read off the instance's
 *  presentation-override config — generic, nothing filament-specific. */
interface ParentConfig {
  instance: string;
  label?: string;
  key_fields?: string[];
  copy_fields?: string[];
}

/** Shown when the selected table is a CHILD instance with a `parent` type
 *  (Spools → Filament Types). It answers the question the auto-lift will
 *  resolve on commit — *does this type already exist?* — BEFORE you commit:
 *  match the in-progress item's `key_fields` against the parent instance's
 *  rows and show "adding to an existing <type>" vs "a new <type> will be
 *  created", with the defining fields (+ a colour swatch). Commit behaviour is
 *  unchanged — `inventory:lift-to-type` still does the find-or-create. Purely
 *  generic: the keys, label, and parent instance all come from the config. */
function ParentTypeCard({
  slug,
  menu,
  parent,
  values,
  childNoun,
}: {
  slug: string;
  menu: ScanMenuEntry[] | null;
  parent: ParentConfig;
  /** The child item's current field values (merged custom fields + brand). */
  values: Record<string, unknown>;
  /** The child instance's own noun ("spool") for the copy. */
  childNoun: string;
}) {
  const typeLabel = parent.label?.trim() || "type";
  const keyFields = parent.key_fields ?? [];
  const items = useQuery({
    queryKey: ["instance-items", slug, parent.instance],
    queryFn: () =>
      api.request<{ items: Array<Record<string, unknown> & { id: string; name: string; metadata?: Record<string, unknown> }> }>(
        "GET",
        `/orgs/${slug}/instances/${parent.instance}/items`,
      ),
    enabled: !!slug && !!parent.instance,
    staleTime: 15_000,
  });

  // Labels for the parent's fields come from its scan-menu entry (so the chips
  // read "Material", "Colour" — not the raw key). Falls back to humanizeKey.
  const parentEntry = (menu ?? []).find((m) => m.instance === parent.instance);
  const labelOf = (k: string) =>
    parentEntry?.fields.find((f) => f.name === k)?.label ?? humanizeKey(k);

  // Match the in-progress item against the parent instance's rows (same
  // find-or-create rule the commit-time auto-lift uses).
  const { present, match } = matchParentType(items.data?.items ?? [], keyFields, values);
  const typeVal = readField;

  const chip = (k: string, v: unknown) => {
    const sw = /colou?r/i.test(k) ? colorSwatch(v) : null;
    return (
      <span
        key={k}
        className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-0.5 text-[11px]"
      >
        {sw && <span className="h-3 w-3 shrink-0 rounded-full border border-line dark:border-slate-600" style={{ background: sw }} />}
        <span className="text-faint dark:text-slate-500">{labelOf(k)}</span>
        <span className="font-medium text-content dark:text-mortar-100">{String(v)}</span>
      </span>
    );
  };

  let body: ReactNode;
  if (items.isLoading) {
    body = <div className="text-[11px] text-faint dark:text-slate-500">Checking existing {typeLabel.toLowerCase()}s…</div>;
  } else if (present.length === 0) {
    body = (
      <div className="text-[11px] text-faint dark:text-slate-500">
        Fill {keyFields.map(labelOf).join(" / ") || "the defining fields"} and we'll match this to a {typeLabel.toLowerCase()} (or create one).
      </div>
    );
  } else if (match) {
    body = (
      <>
        <div className="text-[12px] text-content dark:text-mortar-100">
          <span className="font-semibold text-moss-600 dark:text-moss-400">✓ Existing {typeLabel.toLowerCase()}</span>
          {" — "}this {childNoun} will be added to{" "}
          <span className="font-semibold">{String(match.name)}</span>.
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {[...(parent.key_fields ?? []), ...(parent.copy_fields ?? [])]
            .map((k) => [k, typeVal(match, k)] as const)
            .filter(([, v]) => v != null && v !== "")
            .map(([k, v]) => chip(k, v))}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="text-[12px] text-content dark:text-mortar-100">
          <span className="font-semibold text-cobble-600 dark:text-cobble-300">✦ New {typeLabel.toLowerCase()}</span>
          {" — "}no match yet, so a {typeLabel.toLowerCase()} will be created from these and this {childNoun} linked to it.
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {present.map((k) => chip(k, values[k]))}
        </div>
      </>
    );
  }

  return (
    <div className="rounded-md border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 px-3 py-2 sm:col-span-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">
        {typeLabel}
      </div>
      {body}
    </div>
  );
}

// ── the inline confirm form — driven by the workspace scan MENU ───────
// Series banner: when several pending items were identified as belonging to the
// SAME series/franchise (Harry Potter, Little House), offer to tag them all with
// the series in one tap. The series comes from the vision identify
// (suggested_metadata.series); tagging reuses the apply-theme loop, so the tag
// rides to each entity at confirm — books to Bookshelf, all carrying the series.
/** The date printed ON a receipt, when its lines carry one.
 *
 *  Every line of a parsed receipt is stamped with the receipt's own date, so the
 *  session can say when the shopping happened rather than when the photo was
 *  taken. Null for an ordinary scan session, which has no date but its own. */
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

function seriesOf(it: ScanInboxItem): string | null {
  const s = (it.suggested_metadata as { series?: unknown } | null)?.series;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}
/** Does this item already carry `tag` in its queued pending_tags? (Stashed by a
 *  prior "Tag series"; applied to the entity at confirm.) The banner keys its
 *  offer off this so it stops re-offering a tag the items already have. */
function hasPendingTag(it: ScanInboxItem, tag: string): boolean {
  const pt = (it.suggested_metadata as { pending_tags?: unknown } | null)?.pending_tags;
  const want = tag.trim().toLowerCase();
  return Array.isArray(pt) && pt.some((t) => typeof t === "string" && t.trim().toLowerCase() === want);
}
function SeriesBanner({ slug, items }: { slug: string; items: ScanInboxItem[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // Series the user has ACCEPTED this session (tapped "Tag series"). We keep
  // auto-applying them to late-arriving members instead of re-surfacing the
  // banner — incremental vision identify means a book can join the group AFTER
  // the tap (that's the "1 of 9 isn't tagged yet" straggler the author hit: they tagged
  // the 8, "The Long Winter" identified two days later and was never swept in).
  // Sticky = tag the straggler and stay quiet.
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  // ids we've already fired an auto-tag for, so a slow refetch can't double-fire.
  const autoTagged = useRef<Set<string>>(new Set());
  const apply = useMutation({
    mutationFn: ({ series, ids }: { series: string; ids: string[]; silent?: boolean }) =>
      api.applyScanTheme(slug, { tag: series, tag_item_ids: ids }),
    onSuccess: (r, v) => {
      // Only toast when the user tapped (a real batch); silent for the sticky
      // auto-tag of a single straggler so it doesn't nag.
      if (!v.silent) toast.success(`Tagged ${r.tagged} as "${v.series}" — applied when you confirm each.`);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      // Remember the series so late members auto-tag. NOT `dismissed` — a dismiss
      // would also hide a genuinely-new straggler; accepted keeps sweeping it in.
      setAccepted((a) => new Set([...a, v.series.toLowerCase()]));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't apply that."),
  });
  // Group pending items by series, splitting members by how confident the match
  // is: `vision` = the item's OWN vision series matches (canonical); `pullIn` =
  // a same-author seriesless book folded in (a weak "probably in the series"
  // guess — only when that author has exactly ONE series here, no ambiguity).
  // The split matters for stickiness: we auto-sweep late VISION members but never
  // a weak pull-in (see the effect below).
  const groups = useMemo(() => {
    const m = new Map<string, { series: string; vision: ScanInboxItem[]; pullIn: ScanInboxItem[] }>();
    for (const it of items) {
      const s = seriesOf(it);
      if (!s) continue;
      const key = s.toLowerCase();
      if (!m.has(key)) m.set(key, { series: s, vision: [], pullIn: [] });
      m.get(key)!.vision.push(it);
    }
    const authorSeries = new Map<string, Set<string>>();
    for (const g of m.values())
      for (const it of g.vision) {
        const a = creatorOf(it)?.toLowerCase();
        if (!a) continue;
        if (!authorSeries.has(a)) authorSeries.set(a, new Set());
        authorSeries.get(a)!.add(g.series.toLowerCase());
      }
    for (const it of items) {
      if (seriesOf(it)) continue; // grouped by its own series already
      const a = creatorOf(it)?.toLowerCase();
      const forAuthor = a ? authorSeries.get(a) : undefined;
      if (!forAuthor || forAuthor.size !== 1) continue; // no / ambiguous series
      const g = m.get([...forAuthor][0]!);
      if (g && !g.vision.some((x) => x.id === it.id) && !g.pullIn.some((x) => x.id === it.id)) g.pullIn.push(it);
    }
    return m;
  }, [items]);

  // Sticky sweep: for every ACCEPTED series, auto-tag any untagged VISION member
  // (its own series matches — confident), catching the late straggler without
  // re-surfacing the banner. Author pull-ins are NEVER auto-tagged (weak guess →
  // still need an explicit tap). The refetch after each tag re-runs this until
  // there's nothing left to sweep.
  useEffect(() => {
    if (apply.isPending) return;
    for (const key of accepted) {
      const g = groups.get(key);
      if (!g) continue;
      const late = g.vision.filter((it) => !hasPendingTag(it, g.series) && !autoTagged.current.has(it.id));
      if (late.length) {
        for (const it of late) autoTagged.current.add(it.id);
        apply.mutate({ series: g.series, ids: late.map((i) => i.id), silent: true });
        return; // one series per pass; the refetch re-triggers for the rest
      }
    }
  }, [groups, accepted, apply]);

  // Banners to SHOW. For an ACCEPTED series the vision members auto-sweep (above),
  // so only surface it if untagged author PULL-INS remain (those need an explicit
  // tap). For a fresh series, offer the whole untagged set as before.
  const offers = useMemo(() => {
    const out: Array<{ series: string; items: ScanInboxItem[]; untagged: ScanInboxItem[] }> = [];
    for (const [key, g] of groups) {
      if (dismissed.has(key)) continue;
      const all = [...g.vision, ...g.pullIn];
      if (all.length < 2) continue;
      const untagged = accepted.has(key)
        ? g.pullIn.filter((it) => !hasPendingTag(it, g.series)) // vision handled by the sweep
        : all.filter((it) => !hasPendingTag(it, g.series));
      if (untagged.length === 0) continue;
      out.push({ series: g.series, items: all, untagged });
    }
    return out;
  }, [groups, dismissed, accepted]);
  if (offers.length === 0) return null;
  return (
    <>
      {offers.map((g) => (
        <div key={g.series} className="rounded-lg border border-cobble-300 dark:border-cobble-700/60 bg-cobble-50/70 dark:bg-cobble-950/20 px-3 py-2.5 flex items-center gap-3">
          <Sparkles size={15} className="text-accent shrink-0" />
          <div className="min-w-0 flex-1 text-sm text-content dark:text-mortar-100">
            {g.untagged.length === g.items.length ? (
              <>
                {g.items.length} item{g.items.length === 1 ? " is" : "s are"} part of the{" "}
                <strong>"{g.series}"</strong> series.
                <span className="text-muted"> Tag them all "{g.series}"?</span>
              </>
            ) : (
              <>
                {g.untagged.length} of {g.items.length} <strong>"{g.series}"</strong>{" "}
                {g.untagged.length === 1 ? "item isn't" : "items aren't"} tagged yet.
                <span className="text-muted"> Tag {g.untagged.length === 1 ? "it" : "them"}?</span>
              </>
            )}
          </div>
          <button
            type="button"
            disabled={apply.isPending}
            onClick={() => apply.mutate({ series: g.series, ids: g.untagged.map((i) => i.id) })}
            className="shrink-0 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {apply.isPending ? "Tagging…" : "Tag series"}
          </button>
          <button type="button" onClick={() => setDismissed((d) => new Set([...d, g.series.toLowerCase()]))} className="shrink-0 text-faint hover:text-content p-1" title="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </>
  );
}

// Session-theme banner: after a batch, offer to TAG everything with a derived
// theme + suggest a CATEGORY for the non-media subset — e.g. "these 6 things →
// tag 'Camping', category 'Camp Cookware' on the 2 pots, leaving the 4 books
// tagged but uncategorized." Nothing hardcoded; derived server-side, degrades to nothing.
function SessionThemeBanner({ slug, pendingCount }: { slug: string; pendingCount: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dismissed, setDismissed] = useState(false);
  const theme = useQuery({
    queryKey: ["scan-session-theme", slug, pendingCount],
    queryFn: () => api.scanSessionTheme(slug),
    enabled: !!slug && pendingCount >= 2 && !dismissed,
    staleTime: 60_000,
  });
  const apply = useMutation({
    mutationFn: () =>
      api.applyScanTheme(slug, {
        ...(theme.data?.tag ? { tag: theme.data.tag, tag_item_ids: theme.data.tag_item_ids } : {}),
        ...(theme.data?.category ? { category: theme.data.category } : {}),
      }),
    onSuccess: (r) => {
      toast.success(
        `Tagged ${r.tagged}${r.categorized ? ` · categorised ${r.categorized}` : ""} — applied when you confirm each.`,
      );
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      setDismissed(true);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't apply that."),
  });
  const t = theme.data;
  if (dismissed || !t || (!t.tag && !t.category)) return null;
  return (
    <div className="rounded-lg border border-cobble-300 dark:border-cobble-700/60 bg-cobble-50/70 dark:bg-cobble-950/20 px-3 py-2.5 flex items-center gap-3">
      <Sparkles size={15} className="text-accent shrink-0" />
      <div className="min-w-0 flex-1 text-sm text-content dark:text-mortar-100">
        These {t.tag_item_ids.length || pendingCount} look related.
        {t.tag ? <> Tag them all <strong>"{t.tag}"</strong>.</> : null}
        {t.category ? (
          <span className="text-muted"> {t.tag ? "Also add" : "Add"} category <strong>"{t.category.value}"</strong> to {t.category.item_ids.length} of them.</span>
        ) : null}
      </div>
      <button
        type="button"
        disabled={apply.isPending}
        onClick={() => apply.mutate()}
        className="shrink-0 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
      >
        {apply.isPending ? "Applying…" : "Apply"}
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
function ConfirmForm({
  item,
  menu,
  candidates,
  hasLocations,
  initialKey,
  prefill,
  onDone,
  onCancel,
  onCollapse,
  actionSlot,
  fieldSlot,
  locSlot,
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
  /** Collapse the whole card. Rendered beside Confirm so the control keeps
   *  the same home it has when the form is closed. */
  onCollapse?: () => void;
  /** Where the commit pair renders. The card gives the form the SAME slot the
   *  "Add to Inventory" pair uses when the form is closed, so the action anchor
   *  never moves between the two states. Null renders them inline. */
  actionSlot?: HTMLElement | null;
  /** Where the FIELDS render. Given a slot, the chips join the card's own chip
   *  row - the one that already shows them read-only - instead of being a
   *  second copy of that row lower down. The form keeps all of its state and
   *  submission; only the chips move. */
  fieldSlot?: HTMLElement | null;
  /** Where the LOCATION drawer opens: the seam under the chip strip that holds
   *  its trigger. Null renders it inline, at the bottom of the form. */
  locSlot?: HTMLElement | null;
}) {
  const { activeSlug, activeOrg } = useActiveOrg();
  const { user } = useAuth();
  const isAdmin = !!user?.is_platform_admin;
  // Installing a bundle changes workspace composition → owner/admin only (the
  // materialize endpoint enforces this). Gate the install-and-add card on it so
  // an editor doesn't hit a 403 dead-end; they still get the normal picker.
  // Editor included: the server-side enable path (module enable behind the
  // confirm) allows editor too, and gating the UI stricter than the API just
  // hands editors a raw 409 instead of the install flow (2026-08-25 audit).
  const canInstallBundle =
    activeOrg?.role === "owner" || activeOrg?.role === "admin" || activeOrg?.role === "editor";
  const qc = useQueryClient();
  const toast = useToast();
  // Platform-admin only: capture this corrected commit as a matchmaker eval case.
  const [saveEvalCase, setSaveEvalCase] = useState(false);
  const [evalNote, setEvalNote] = useState("");

  // The workspace scan menu (with named instances like "Yarn") loads async, so
  // while it's in flight `menu` is null and we'd otherwise pick from FALLBACK_MENU
  // — which has ONLY the generic base tables. Seed the routed live-instance
  // candidates into the menu from the candidate itself (`withRoutedInstances`),
  // so a yarn-routed scan defaults to "Yarn" on the FIRST render instead of
  // flashing "Inventory part" (and filing there if the user confirms before the
  // fetch lands). Once the real menu resolves it already carries the instance —
  // with field defs — and the placeholder is dropped as a duplicate.
  const baseEntries = withRoutedInstances(
    menu && menu.length > 0 ? menu : FALLBACK_MENU,
    candidates,
  );
  // A not-installed flagship bundle can BE the best match (a scanned VIN →
  // "Vehicles"). Rather than dropping to Inventory with read-only chips, make it
  // a FIRST-CLASS editable destination that leads the picker and is the default:
  // fetch its field DEFS from the bundle menu and offer "Vehicles (installs on
  // confirm)"; the install happens as part of Confirm (nothing is created until
  // then). Owner/admin only — installing changes workspace composition.
  const topBundleCand = canInstallBundle && candidates[0]?.bundle_external_id ? candidates[0] : null;
  const bundleMenuQ = useQuery({
    queryKey: ["scan-bundle-menu", activeSlug],
    queryFn: () => api.scanBundleMenu(activeSlug),
    enabled: !!activeSlug && !!topBundleCand,
    staleTime: 5 * 60_000,
  });
  const willInstallEntry: (ScanMenuEntry & { bundle_external_id?: string }) | null =
    topBundleCand?.bundle_external_id
      ? (bundleMenuQ.data?.items ?? []).find(
          (m) =>
            m.bundle_external_id === topBundleCand.bundle_external_id &&
            m.module === topBundleCand.module &&
            (m.instance ?? null) === (topBundleCand.instance ?? null),
        ) ?? null
      : null;
  const willInstallKey = willInstallEntry ? entryKey(willInstallEntry.module, willInstallEntry.instance) : null;
  // The will-install destination leads the picker; dedupe against the base menu.
  const entries =
    willInstallEntry && !baseEntries.some((m) => entryKey(m.module, m.instance) === willInstallKey)
      ? [willInstallEntry, ...baseEntries]
      : baseEntries;
  // Initial pick: the will-install bundle when it's the top match, else the
  // routed entry, else a GENERIC default table (never an arbitrary named
  // instance). pickDestinationKey is pure + unit-tested in scanDestination.ts.
  const hintedKey =
    willInstallKey ??
    pickDestinationKey({
      initialKey,
      entries,
      entityType: (item.suggested_metadata as { entity_type?: string } | null)?.entity_type ?? null,
    });
  const [selKey, setSelKey] = useState<string>(hintedKey);
  // `withRoutedInstances` keeps `hintedKey` correct for a routed LIVE instance
  // even mid-load, so this adopt-on-change mainly covers the OTHER direction: a
  // routed candidate that turns out NOT to be a real table (a not-yet-installed
  // bundle key the loaded menu doesn't carry) → `hintedKey` flips to the generic
  // default once the menu resolves, and we follow it. When the real menu resolves
  // and now contains the routed instance, adopt it — unless the user already
  // picked a destination by hand.
  const userPickedDest = useRef(false);
  useEffect(() => {
    if (userPickedDest.current) return;
    if (selKey !== hintedKey) setSelKey(hintedKey);
  }, [hintedKey]);
  const entry =
    entries.find((m) => entryKey(m.module, m.instance) === selKey) ?? entries[0]!;

  // The matchmaker candidate for the initial selection: its extraction seeds
  // the fields and its cleaned `name` (retailer noise stripped) beats the raw
  // lookup title.
  const initialCand =
    candidates.find((c) => entryKey(c.module, c.instance) === hintedKey) ?? null;

  // If the selected table is a CHILD instance with a `parent` type (Spools →
  // Filament Types), read its parent config off the presentation override so
  // the form can show whether the type already exists. Generic — the keys all
  // come from config; nothing here knows "filament".
  const overrides = useQuery({
    queryKey: ["entity-kind-overrides", activeSlug],
    queryFn: () => api.listOverrides(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const parentConfig: ParentConfig | null = (() => {
    if (!entry.instance) return null;
    const o = (overrides.data?.items ?? []).find(
      (x) => x.target_kind === "instance" && x.target_id === `${entry.module}:${entry.instance}`,
    );
    const p = o?.config?.parent as ParentConfig | undefined;
    return p && p.instance ? p : null;
  })();

  const [name, setName] = useState(initialCand?.name ?? item.suggested_name ?? "");
  // Editing NAME here used to change only what the item would be FILED as: the
  // value went to confirmScanItem and never to the row, so the card's title kept
  // showing the AI's name, and leaving without committing threw the correction
  // away (reported 2026-08-13). Renaming an inbox item is already a supported
  // action - five other surfaces call updateScanItem({ name }) - so this one
  // joins them.
  //
  // ONLY ON A REAL EDIT, though, and that guard is load-bearing rather than
  // tidy. This field is seeded from the CANDIDATE's reconciled name, which
  // legitimately differs from the row's, so a blur-triggered save would rewrite
  // suggested_name just because someone opened the form and tabbed past. Worse:
  // PATCH /inbox/:id reports a renamed BARCODE item to the shared Barcode
  // Intelligence DB, so that phantom rename would publish a bogus correction to
  // every workspace that ever scans that UPC.
  const persistName = useMutation({
    mutationFn: (next: string) => api.updateScanItem(activeSlug, item.id, { name: next }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] }),
    // NOT silent: this card's own Confirm re-sends the name, but "File all"
    // reads the ROW's stored name - so a rename that silently failed meant the
    // bulk path filed the AI's original with no sign the correction was lost
    // (2026-08-25 audit).
    onError: () => toast.error("Couldn't save the new name - File all would use the old one. Try again."),
  });
  const commitNameEditWith = (next: string) => {
    if (shouldPersistNameEdit({ dirty: true, next, rowName: item.suggested_name })) {
      persistName.mutate(next.trim());
    }
  };
  // A serial/service tag the vision read off the label. It already commits to the
  // destination's native serial_number column, but was never SHOWN — so the user
  // couldn't tell it was captured (and the matchmaker note "no serial field in
  // this table" reinforced that). Surface it, pre-filled + editable (fix OCR
  // slips), for items where a serial applies: one was captured, or the target is
  // equipment (machines/assets). It rides to the native column via `extras`.
  // A decoded IDENTIFIER is a serial: the Vehicles bundle tags `serial_number` as
  // `identifier:vin`, so a VIN scan's code belongs in this box. Before, the VIN sat
  // in the card's title while the very field declared to hold it was blank.
  const decodedIdentifier = (() => {
    const m = item.suggested_metadata as { decoded?: { decoder_id?: string } } | null;
    return m?.decoded?.decoder_id ? (item.barcode_text ?? "") : "";
  })();
  const capturedSerial =
    String((item.suggested_metadata as { serial_number?: unknown } | null)?.serial_number ?? "") ||
    decodedIdentifier;
  const [serial, setSerial] = useState(capturedSerial);
  const showSerial = !!capturedSerial || entry.module === "machines" || entry.module === "assets";
  // The destination's native-field PRESENTATION. A bundle can relabel a native
  // field per kind (manufacturer -> "Make", serial_number -> "VIN"); every other
  // entity form reads this, but the confirm form hardcoded its labels, so a
  // bundle's relabels stopped at its door. You could install Vehicles and still be
  // asked for a "Serial number" on a card whose subtitle was a VIN.
  const presentation = useFieldPresentation(entry.kind ?? "");
  const fieldLabel = (nativeName: string, fallback: string) =>
    presentation.label(nativeName, fallback);
  const aiStatus = useAiStatus();
  // Quantity: the matchmaker's pack-count read ("1 Pack Of 9 Skein" -> 9)
  // beats the row's default 1; an explicitly-set row quantity beats both.
  const initialQty = (() => {
    const cand = candidates.find((c) => entryKey(c.module, c.instance) === hintedKey);
    if ((item.quantity ?? 1) > 1) return item.quantity;
    return cand?.quantity ?? item.quantity ?? 1;
  })();
  const [quantity, setQuantity] = useState<number>(initialQty);
  // Pre-fill from the filing bin stamped at scan time (target_location_id), so a
  // deferred triage already knows where it was scanned; the scan_area string-match
  // effect below only fires as a fallback when no bin was set.
  const [locationId, setLocationId] = useState<string>(item.target_location_id ?? "");
  // Pre-fill the looked-up brand; the table's own fields (colour, fibre…)
  // seed from the lookup metadata, then the matchmaker's extraction wins.
  const [manufacturer, setManufacturer] = useState(item.suggested_manufacturer ?? "");
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(() => {
    const meta = (item.suggested_metadata as Record<string, unknown> | null) ?? {};
    const seed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (v != null && v !== "" && typeof v !== "object") seed[k] = v;
    }
    // A vendor/URL resolver (a Polar spool QR, …) stows its PARSED FIELDS as a
    // nested `fields` object — size, batch_code, material, … keyed to field-def
    // names. The loop above skips objects, so without this those parsed fields
    // never reach the form (the "all the info is there but nothing's filled in"
    // bug). Spread them in over the flat seed.
    for (const [k, v] of Object.entries(parsedScanFields(meta))) {
      if (v != null && v !== "") seed[k] = v;
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
  // The location chips stay COLLAPSED behind a dropdown-style trigger — a full
  // location tree (every room + every bin) dumped inline swamped the form.
  const [locOpen, setLocOpen] = useState(false);
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

  // The selected destination is a not-installed bundle when the entry carries a
  // `bundle_external_id` (the will-install "Vehicles" entry). Confirm installs it
  // first, then files into it — so nothing is created until the user confirms.
  const willInstall = (entry as { bundle_external_id?: string }).bundle_external_id ?? null;

  // Picking a location PERSISTS immediately (target_location_id on the inbox item),
  // not only when you Confirm. Two reasons: you shouldn't have to commit the whole
  // item just to say where it goes, and the 8s inbox poll re-renders this card —
  // local-only state was getting reset, so the pick "didn't stick". Persisting +
  // invalidating means the item re-seeds from the saved value, so it survives.
  const persistLocation = useMutation({
    mutationFn: (locId: string | null) =>
      api.updateScanItem(activeSlug, item.id, { target_location_id: locId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const confirmMut = useMutation({
    mutationFn: async () => {
      // `extras.metadata` (the table's fields the user filled — colorway,
      // fibre, …) is deep-merged server-side (keeps the scan's barcode/sku);
      // manufacturer overrides the lookup's.
      const cleanMeta = Object.fromEntries(
        Object.entries(customValues).filter(([, v]) => v != null && v !== ""),
      );
      const extras = {
        ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}),
        // Top-level (not under metadata) so it lands in the destination's NATIVE
        // serial_number column via the confirm handler's restExtras.
        ...(serial.trim() ? { serial_number: serial.trim() } : {}),
        ...(Object.keys(cleanMeta).length ? { metadata: cleanMeta } : {}),
      };
      // A will-install destination is created FIRST (materialize with no item_ids
      // installs the bundle + its table, committing nothing), then we file THIS
      // item into it with the EDITED values — same commit path as any table.
      let formInstalled: BundleInstallSummary | null = null;
      const entryInstance = await resolveInstanceForFiling(activeSlug, willInstall, entry.instance, (sum) => {
        formInstalled = sum;
      });
      const confirmed = await api.confirmScanItem(activeSlug, item.id, {
        target_module: entry.module,
        target_kind: baseKind(entry.module),
        instance: entryInstance,
        name: name.trim() || (item.suggested_name ?? "Untitled"),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
        location_id: locationId || undefined,
        extras: Object.keys(extras).length ? extras : undefined,
        ...(isAdmin && saveEvalCase
          ? { save_eval_case: true, eval_note: evalNote.trim() || undefined }
          : {}),
      });
      const sum: BundleInstallSummary | null = formInstalled;
      return { ...confirmed, installedSummary: sum ? installToastLine(sum) : null };
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
          {willInstall ? `Installed ${entry.label}. Added ` : "Created. Open "}
          <a href={`/w/${activeSlug}${dest}`} className="underline">
            {r.item.suggested_name ?? "the new entity"}
          </a>
          {/* What the install changed rides in the SAME toast, for the same
              reason as the pill: one tap should not raise two of them. */}
          {r.installedSummary ? ` ${r.installedSummary}` : ""}
        </span> as never,
      );
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      // A will-install commit just added a module/instance/table — refresh nav +
      // menus so everything reflects the new install.
      if (willInstall) {
        void qc.invalidateQueries({ queryKey: ["scan-menu", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["org-modules", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["instances", activeSlug] });
      }
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // dark: fields sit one step LIGHTER (slate-800) than the slate-900 card +
  // a visible border — they were blending into the background (the author).
  // ── the chip field model ────────────────────────────────────────────────
  // One list of {key,label,value}; ChipFields decides the layout. A field is
  // OFFERED rather than shown when the table declares it and nothing filled it,
  // which is what stops a dozen empty boxes from owning the page.
  const [addedFields, setAddedFields] = useState<string[]>([]);
  const selectedLoc = locationId ? (locs.data?.items ?? []).find((l) => l.id === locationId) : null;
  const locLabel = selectedLoc ? (selectedLoc.short_name?.trim() || selectedLoc.name) : locationId ? "…" : "";

  const setChipValue = (key: string, value: string) => {
    if (key === "name") { setName(value); commitNameEditWith(value); return; }
    if (key === "manufacturer") { setManufacturer(value); return; }
    if (key === "serial_number") { setSerial(value); return; }
    if (key === "quantity") { setQuantity(Number(value) || 1); return; }
    setCustomValues((m) => ({ ...m, [key]: value }));
  };

  const builtins: ChipFieldDef[] = [
    { key: "name", label: fieldLabel("name", "Name"), value: name, placeholder: item.suggested_name ?? "" },
    { key: "manufacturer", label: fieldLabel("manufacturer", "Brand"), value: manufacturer },
    ...(showSerial ? [{ key: "serial_number", label: fieldLabel("serial_number", "Serial no."), value: serial }] : []),
    { key: "quantity", label: "Qty", value: String(quantity), type: "number" as const },
    ...(hasLocations
      ? [{
          key: "location",
          label: "Location",
          value: locLabel,
          emptyHint: "set",
          icon: locLabel ? <MapPin size={12} className="shrink-0 text-accent" /> : null,
          onActivate: () => setLocOpen((o) => !o),
        }]
      : []),
  ];
  const customChips: ChipFieldDef[] = (entry.fields ?? []).map((f) => ({
    key: f.name,
    label: f.label ?? f.name,
    value: String(customValues[f.name] ?? ""),
    type: (f.type === "select" ? "select" : f.type === "date" ? "date" : f.type === "number" ? "number" : "text") as ChipFieldType,
    choices: f.choices ?? null,
  }));
  const all = [...builtins, ...customChips];
  // On the item = it has a value, it is always-on (name / add-to / qty), or the
  // user just asked for it.
  const ALWAYS = new Set(["name", "quantity"]);
  const chipFields = all.filter((f) => f.value || ALWAYS.has(f.key) || addedFields.includes(f.key));
    // Confirm leads, Cancel under it, collapse last: the same primary-first
    // order as the closed state's "Add to Inventory… / collapse", so the corner
    // reads the same way in both states.
  const chipAvailable = all.filter((f) => !chipFields.includes(f));

  const formId = `confirm-${item.id}`;
  const commitActions = (
    // A vertical stack against the right edge, the same shape the closed state
    // uses for "Add to Inventory / collapse", so the
    // action corner looks identical whichever state the card is in.
    <div className="flex flex-col items-end gap-1">
            <button
              type="submit"
        form={formId}
              disabled={confirmMut.isPending || (!name.trim() && !item.suggested_name)}
              className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50 inline-flex items-center gap-1"
            >
              {willInstall ? <Download size={14} /> : <CheckCircle size={14} />}
              {confirmMut.isPending
                ? willInstall
                  ? `Installing ${entry.label}…`
                  : "Creating…"
                : willInstall
                  ? `Install ${entry.label} & add`
                  : "Confirm"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            {onCollapse && (
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Collapse this item"
                title="Collapse"
                className="shrink-0 rounded-md border border-line dark:border-slate-700 p-1.5 text-faint hover:text-accent hover:border-accent transition"
              >
                <ChevronDown size={14} className="rotate-180" />
              </button>
            )}
    </div>
  );

  const inputCls =
    "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800";

  // Rendered ONCE and placed by branch below. The slotted branch (header row)
  // and the inline branch (no slot) used to carry their own copies of both
  // of these, ~60 lines apiece, which is exactly how the two would drift.
  // The destination is a CHIP, not a labelled block. As its own block it read
  // as a separate control sitting apart from the fields, when it is simply the
  // first thing you choose about this item. Same shell, same label treatment.
  const destinationChip = (
    <label className="inline-flex items-baseline gap-1.5 max-w-full rounded-lg border px-2 py-1 cursor-pointer transition border-line/70 dark:border-slate-700/70 bg-subtle/50 dark:bg-slate-800/50 hover:border-cobble-400 dark:hover:border-cobble-600">
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">Add to</span>
      <select
        value={selKey}
        onChange={(e) => {
          const k = e.target.value;
          userPickedDest.current = true;
          setSelKey(k);
          // Switching to a table the matchmaker already extracted for →
          // merge its field values in (typed values keep winning where
          // the user edited a key the candidate also fills).
          const cand = candidates.find((c) => entryKey(c.module, c.instance) === k);
          if (cand && Object.keys(cand.fields).length) {
            setCustomValues((prev) => ({ ...cand.fields, ...prev }));
          }
        }}
        // Full width is a phone constraint, not a desktop one. A destination
        // reads in a few words, so on a wide form it only needs to be as wide
        // as its longest option; stretching it across the form makes it look
        // like the page's main input, which it is not now that the fields
        // beside it are chips.
        className="bg-transparent border-0 p-0 pr-1 text-sm outline-none max-w-[16rem] cursor-pointer"
      >
        {entries.map((m) => {
          const wi = (m as { bundle_external_id?: string }).bundle_external_id;
          return (
            <option key={entryKey(m.module, m.instance)} value={entryKey(m.module, m.instance)}>
              {m.label}
              {m.instance ? "" : ` (${m.noun})`}
              {wi ? " · installs on confirm" : ""}
            </option>
          );
        })}
      </select>
    </label>
  );
  const fieldChips = (dense: boolean) => (
    <ChipFields
      dense={dense}
      fields={chipFields}
      available={chipAvailable}
      onChange={setChipValue}
      renderEditor={(f) => {
        const def = (entry.fields ?? []).find((x) => x.name === f.key);
        if (!def) return null;
        const rich = def.type === "boolean" || wantsSwatch({ ...def, display_label: f.label } as never) || !!def.help;
        if (!rich) return null;
        return (
          <ScanFieldInput
            def={{ name: def.name, display_label: def.label ?? def.name, type: def.type,
                   help: def.help ?? null, choices: def.choices ?? null }}
            value={customValues[def.name]}
            onChange={(v) => setCustomValues((m) => ({ ...m, [def.name]: v }))}
          />
        );
      }}
      onAdd={(k) => setAddedFields((prev) => (prev.includes(k) ? prev : [...prev, k]))}
      onDrop={(k) => setAddedFields((prev) => prev.filter((x) => x !== k))}
    />
  );

  return (
    <>
    <form
      id={formId}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() && !item.suggested_name) return;
        confirmMut.mutate();
      }}
      // With the fields and the commit pair portalled up into the card, what
      // is LEFT in this element is conditional: the install explainer, the AI-off
      // hint, the location drawer, the admin eval box. For most users at most
      // moments that is nothing - and an empty form still spent its spacing
      // (measured: 61px below the strip on a card that showed no such thing).
      // Its children carry their own gap, so it carries none.
      className="empty:hidden [&>*+*]:mt-3"
    >
      {/* The selected destination is a bundle this workspace doesn't have yet
          (a scanned VIN → "Vehicles"). It's the DEFAULT + leads the picker, its
          fields render editable + pre-filled below, and Confirm creates its table
          first. A slim note makes that clear; picking another table opts out. */}
      {willInstall && (
        <div className="flex items-start gap-2 rounded-lg border border-accent/50 bg-accent/[0.06] dark:bg-accent/10 p-3 text-xs text-muted dark:text-slate-400">
          <Sparkles size={14} className="text-accent shrink-0 mt-0.5" />
          <span>
            You don't have <span className="font-semibold text-content dark:text-mortar-100">{entry.label}</span> yet - {" "}
            <strong>Confirm</strong> installs it (its own table + nav entry) and files this in, with the fields below. Want to
            track it another way? Pick a different table in <em>Add to</em>.
          </span>
        </div>
      )}
      {parentConfig && (
        <ParentTypeCard
          slug={activeSlug}
          menu={menu}
          parent={parentConfig}
          values={{ ...customValues, manufacturer }}
          childNoun={entry.noun}
        />
      )}
      {/* Destination and fields SHARE a row. Stacked, they used about a
          third of a full-width form and left the rest of the panel empty,
          while the card grew taller for content that already had room. It
          WRAPS, which is why this is not the right-rail attempt that was
          reverted: a full-width row can fall back to stacking, a fixed
          rail cannot. */}
      {fieldSlot ? createPortal(
        // In the header row the destination is the card's own pill, so only
        // the chips go up - at the pill row's chip scale, no wrapper.
        <div className="contents">{fieldChips(true)}</div>,
        fieldSlot,
      ) : (
        <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
          <div className="shrink-0">{destinationChip}</div>
          <div className="flex-1 min-w-[18rem]">{fieldChips(false)}</div>
        </div>
      )}
      {/* The location DRAWER stays exactly as it was: its chip above is only the
          trigger. A picker is not a text box and forcing it into one would lose
          the rooms-and-bins grid the bulk bar and camera also use. */}
      {/* The AI-off hint the name block used to carry: still the moment it is
          worth saying, since a scan with no name at all is what it explains. */}
      {!item.suggested_name && <AiOffMissHint status={aiStatus} />}
      {hasLocations && locOpen && (() => {
        const drawer = (
          <div className="rounded-md border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 p-2 max-h-72 overflow-y-auto">
            <LocationChipPicker
              value={locationId || null}
              onChange={(v) => {
                setLocTouched(true);
                setLocationId(v ?? "");
                persistLocation.mutate(v);
                if (v) setLocOpen(false);
              }}
            />
          </div>
        );
        // Under the chip that opened it. Portalled rather than moved, because the
        // form owns the picker's state and its submission; only where it draws
        // changes.
        return locSlot
          ? createPortal(<div className="px-3 pb-3">{drawer}</div>, locSlot)
          : drawer;
      })()}
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
    </form>
      {actionSlot ? createPortal(commitActions, actionSlot) : (
        <div className="flex justify-end pt-1">{commitActions}</div>
      )}
    </>
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

// `wantsSwatch` (is this field a colour swatch field?) now lives in
// @cobblr/platform-web, shared with EntityThumb. Imported at the top.
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
          <option value=""> - none - </option>
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
