// /scan — the inbox review queue, photo-inbox-grade.
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
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  CheckCircle,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  Flag,
  Image as ImageIcon,
  LayoutGrid,
  Library,
  Loader2,
  MapPin,
  MonitorSmartphone,
  RefreshCw,
  Pencil,
  RotateCcw,
  ScanLine,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  Wand2,
  X,
  Zap,
  Scissors,
} from "lucide-react";
import { Modal, useImageSrc, useToast, usePageTitle, colorSwatch, wantsSwatch } from "@cobblr/platform-web";
import { ScanImportModal } from "../components/ScanImportModal";
import { ExportInboxModal } from "../components/ExportInboxModal";
import { CameraCaptureSheet } from "../components/CameraCaptureSheet";
import { LocationTreePicker } from "../components/LocationTreePicker";
import { LocationChipPicker } from "../components/LocationChipPicker";
import { OrganizePlanSheet, SortingPlanView } from "../components/OrganizePlanSheet";
import { OrganizeWalkSheet } from "../components/OrganizeWalkSheet";
import { LiveSortSheet } from "../components/LiveSortSheet";
import { ImageSearchPicker } from "../components/ImageSearchPicker";
import { ImageLightbox, type LightboxItem } from "../components/ImageLightbox";
import { ReceiptSourceViewer } from "../components/ReceiptSourceViewer";
import { canRerunLookup } from "../lib/scanRerun";
import { TrackedMatchBanner } from "../components/TrackedMatchBanner";
import { BinAdjustModal } from "../components/BinAdjustModal";
import { PairPhoneButton } from "../components/PairPhoneButton";
import { useAiStatus, AiOffNotice } from "../components/AiStatusNotice";
export { useAiStatus, AiOffNotice } from "../components/AiStatusNotice";
import { decideLocationScan, filingLabel } from "../lib/scanFiling";
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
import { matchParentType, readField } from "../lib/parent-type-match";
import { isRerunInFlight, itemEnriching } from "./scan-status";
import { baseKind, confirmBodyFor, isReadyToFile } from "./scanFileAll";
import { usePublishChatContext } from "../lib/chat-context";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";
import { resolveSessionBatch, clearScanSession, readScanSession, isSessionFresh, SESSION_GAP_MS } from "../lib/scanSession";
import { tabBrowserId } from "../hooks/useBrowserDrive";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useFieldPresentation } from "../lib/useFieldPresentation";
import { useAuth } from "../auth/AuthContext";

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
  const ai = items.filter((i) => i.barcode_text && barcodeSourceOf(i) === "ai-photo");
  const scanned = items.filter((i) => i.barcode_text && barcodeSourceOf(i) !== "ai-photo");
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
  if (!drive.on) {
    return (
      <button
        type="button"
        onClick={drive.toggle}
        title="Turn this tab into a second screen that follows scans from another device — scan a bin's QR on your phone and this screen opens that bin. Not needed for normal scanning: a USB/Bluetooth scanner or a photo already lands items in the inbox below."
        className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent dark:hover:text-cobble-300 transition"
      >
        <MonitorSmartphone size={14} className="shrink-0" />
        Drive this screen with scans
      </button>
    );
  }
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
      toast.success("Got it — finding the right table…");
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
      toast.success("Fixed — thanks, that sharpens future scans of this barcode.");
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

export function ScanPage() {
  usePageTitle("Scan");
  const { activeSlug } = useActiveOrg();
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
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [urlsOpen, setUrlsOpen] = useState(false);
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
      const sessionBatch =
        batchId ??
        (await resolveSessionBatch(activeSlug, () =>
          api.createScanBatch(activeSlug).then((b) => b.id).catch(() => null),
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
      if (ok === 1) toast.success("Photo added — AI is identifying it");
      else if (ok > 1) toast.success(`${ok} photos added as one batch — AI is identifying them`);
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // A receipt PDF/photo → core-ai pulls out the line items → one inbox row
  // per item, each triaged into a part below like any other scan.
  async function uploadReceipt(file: File) {
    setUploading(true);
    try {
      const rec = await api.uploadFile(activeSlug, file);
      const out = await api.scanReceipt(activeSlug, rec.id);
      const n = out.receipt.item_count;
      const from = out.receipt.vendor ? ` from ${out.receipt.vendor}` : "";
      toast.success(`Found ${n} item${n === 1 ? "" : "s"}${from} — review below`);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUploading(false);
      if (receiptRef.current) receiptRef.current.value = "";
    }
  }

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
    const m: Record<string, { label: string | null; origin: string | null; source_file_id: string | null; order_ref: string | null }> = {};
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
  // "Needs review" = a pending item that didn't cleanly resolve: no name yet, a
  // low-trust or rate-limited flag, or low confidence. Bulk-confirm the confident
  // ones, then flip this on to focus only on the ones that need a human.
  const needsReview = (it: ScanInboxItem): boolean => {
    if (it.status !== "pending") return false;
    const meta = (it.suggested_metadata ?? {}) as {
      low_trust?: boolean;
      rate_limited?: boolean;
      reviewed?: boolean;
    };
    // "Looks fine" — a human already eyeballed it; stop nagging.
    if (meta.reviewed) return false;
    return (
      !it.suggested_name ||
      !!meta.low_trust ||
      !!meta.rate_limited ||
      (it.ai_confidence != null && Number(it.ai_confidence) < 0.5)
    );
  };
  const [reviewOnly, setReviewOnly] = useState(false);
  // Stale nudge: pending items sitting > 2 days (the window —
  // clutter is the motivator to clear; two days is when it starts to rot).
  const STALE_MS = 2 * 24 * 60 * 60 * 1000;
  const isStale = (it: ScanInboxItem) =>
    it.status === "pending" && Date.now() - new Date(it.created_at).getTime() > STALE_MS;
  const [staleOnly, setStaleOnly] = useState(false);
  const staleCount = items.filter(isStale).length;
  const reviewCount = items.filter(needsReview).length;
  // Tell Ask Cobb what's on this screen, so "what do I have going on?" can
  // reference the inbox backlog (the inbox isn't a record kind Cobb can read).
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
  const searchTokens = searchQ.toLowerCase().split(/\s+/).filter(Boolean);
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
                {exact ? "as" : "≈ one"} you scanned — looks like the same item.
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
              title="Not the same — keep separate"
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
          title="Not the same — keep separate"
          onClick={() => setDismissedCombine((s) => new Set(s).add(sig))}
          className="shrink-0 text-faint hover:text-muted p-1"
        >
          <X size={16} />
        </button>
      </div>
    );
  };

  // Group the inbox for the grouped view (skipped when already scoped to one
  // session via ?batch). An explicit scan SESSION (scan_batch_id) is one group;
  // loose scans with NO batch group by their calendar DAY. So a hardware-scanner
  // session reads as one timed group, and legacy / un-batched items still read as
  // coherent "Today / Yesterday / <date>" buckets instead of one undifferentiated
  // "No session" lump. Newest group first; items keep their created_at-desc order.
  const sessionGroups = useMemo(() => {
    if (batchId) return null;
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
          g = { key: it.scan_batch_id, isBatch: true, batchId: it.scan_batch_id, items: [], latest: 0, lastTouched: 0, area: null, label: meta?.label ?? null, origin: meta?.origin ?? null, sourceFileId: meta?.source_file_id ?? null, orderRef: meta?.order_ref ?? null };
          byBatch.set(it.scan_batch_id, g);
          groups.push(g);
        }
      } else {
        if (!pseudo || !Number.isFinite(t) || pseudoLastT - t > SESSION_GAP_MS) {
          pseudo = { key: `gap:${it.id}`, isBatch: false, batchId: null, items: [], latest: 0, lastTouched: 0, area: null, label: null, origin: null, sourceFileId: null, orderRef: null };
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
  }, [batchId, visibleItems, batchMeta]);
  // Every group (session or day) carries a meaningful time header now, so show
  // them whenever we're grouping at all.
  const showSessionHeaders = !!sessionGroups && sessionGroups.length > 0;
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
    const grp = sessionGroups?.find((g) => g.items.some((i) => i.id === highlightId));
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
    if (!hash.startsWith("#s-") || !sessionGroups?.length) return;
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
    !!sessionGroups?.some((g) => g.isBatch && g.batchId === activeSession.batchId);

  // Auto-retry rate-limited scans, one at a time, paced. Rapid scanning throttles
  // the resolver (go-upc gate / upcitemdb burst); those rows are tagged
  // `rate_limited` and were deliberately NOT cached, so a retry once the gate
  // frees resolves them — the user shouldn't have to re-scan the item. Paced (one
  // per 15s tick, capped at 2 tries each) so we don't re-exhaust the very limit
  // we're waiting on. Reads live cache inside the tick so the interval stays
  // stable (no reschedule churn from the 8s poll).
  const rlAttempts = useRef<Map<string, number>>(new Map());
  // Once an item's retries are spent it should STOP reading "retrying…" — a
  // persistent rate-limit (e.g. the daily upcitemdb quota, which won't clear till
  // UTC midnight) is terminal for now, so the card switches to a nameable
  // "couldn't identify" state. Reactive so the card re-renders when we give up.
  const [rlGaveUp, setRlGaveUp] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!activeSlug) return;
    const MAX_RETRIES = 2;
    const tick = setInterval(() => {
      const cur =
        qc.getQueryData<{ items: ScanInboxItem[] }>(["scan-inbox", activeSlug, batchId])?.items ?? [];
      const target = cur.find(
        (i) =>
          i.status === "pending" &&
          !i.suggested_name &&
          !i.ai_suggested_at &&
          (i.suggested_metadata as { rate_limited?: boolean } | null)?.rate_limited &&
          (rlAttempts.current.get(i.id) ?? 0) < MAX_RETRIES,
      );
      if (!target) return;
      const n = (rlAttempts.current.get(target.id) ?? 0) + 1;
      rlAttempts.current.set(target.id, n);
      if (n >= MAX_RETRIES) setRlGaveUp((s) => new Set(s).add(target.id));
      void api
        .rerunScanAi(activeSlug, target.id)
        .catch(() => {})
        .finally(() => void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] }));
    }, 15_000);
    return () => clearInterval(tick);
  }, [activeSlug, batchId, qc]);

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
  const recentlyCommitted = (resolvedQ.data?.items ?? [])
    .slice()
    .sort((a, b) => String(b.resolved_at ?? "").localeCompare(String(a.resolved_at ?? "")))
    .slice(0, 20);
  const [showCommitted, setShowCommitted] = useState(false);
  // Recently-committed grouped by the SESSION they were committed from, so a whole
  // receipt/scan session committed at once (e.g. "Confirm all") can be sent back in
  // ONE click — not 20 (the author, 2026-07-24). Loose items (no batch) stay as singletons.
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
        // rows that happen to be visible (the author, 2026-07-25).
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
    enabled: !!activeSlug && !upcOpen,
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
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-inbox-resolved", activeSlug] });
      // Undo inline — a mis-tapped "Confirm as purchase order" sends every line
      // back to the inbox (and removes the created part), unsorted, in one tap.
      toast.action(
        r.order_id
          ? `Purchase order created — ${n} item${n === 1 ? "" : "s"}${r.vendor ? ` from ${r.vendor}` : ""}`
          : `Confirmed ${n} item${n === 1 ? "" : "s"} (enable Purchases to group them into an order)`,
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
  // "Confirm as purchase order" rows (the author, 2026-07-24). "Confirm all" turns each
  // receipt into its OWN purchase order (they're separate orders), with one
  // summary toast instead of N.
  const [poExpanded, setPoExpanded] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const confirmAllReceipts = async () => {
    setConfirmingAll(true);
    let orders = 0;
    const committedIds: string[] = [];
    try {
      for (const g of receiptGroups) {
        try {
          const r = await api.confirmReceiptGroup(activeSlug, g.groupId);
          if (r.order_id) orders += 1;
          for (const c of r.confirmed) if (!c.error && c.itemId) committedIds.push(c.itemId);
        } catch {
          /* skip a failed group; the others still go */
        }
      }
      await qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      await qc.invalidateQueries({ queryKey: ["scan-inbox-resolved", activeSlug] });
      const itemsN = committedIds.length;
      // Undo the WHOLE bulk commit — one tap sends every line from every receipt
      // back to the inbox, unsorted, if "Confirm all" was premature (the author, 2026-07-24).
      toast.action(
        orders
          ? `Created ${orders} purchase order${orders === 1 ? "" : "s"} (${itemsN} item${itemsN === 1 ? "" : "s"})`
          : `Confirmed ${itemsN} item${itemsN === 1 ? "" : "s"} (enable Purchases to group them into orders)`,
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

  const headerBtn =
    "inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-700 text-sm text-content hover:bg-subtle dark:hover:bg-slate-800/70 px-2.5 py-1.5 transition shrink-0";

  // Bulk triage: select N items, then confirm / discard the whole selection at
  // once (each confirm routes to its own matchmaker top candidate, fields and
  // all). Loops the existing per-item endpoints — no server change.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
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
  // and every refresh re-forced it against the user's wish (the author, 2026-07-10).
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
  const renderPlanItemCard = (id: string) => {
    const it = items.find((i) => i.id === id);
    if (!it || it.status !== "pending") return null;
    return (
      <InboxCard
        item={it}
        pageTarget={target}
        menu={menu}
        hasLocations={hasLocations}
        rateLimitGaveUp={rlGaveUp.has(it.id)}
        defaultExpanded
        planContext
      />
    );
  };

  const startWalk = async () => {
    setOrganizeOpen(false);
    try {
      const r = await api.getLatestOrganizePlan(activeSlug);
      if (r.plan && r.plan.applied_group_ids.length > 0) setWalkPlan(r.plan);
      else toast.error("Nothing applied to walk yet — accept a group first.");
    } catch {
      toast.error("Couldn't load the plan for the walk.");
    }
  };
  const bulkApplyLocation = async (locId: string) => {
    setBulkBusy(true);
    setBulkLocOpen(false);
    const ids = [...selected];
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
    clearSelected();
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
            toast.success("Merge undone — the session is back on its own");
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
  const setOrderRef = useMutation({
    mutationFn: (v: { batchId: string; orderRef: string | null }) =>
      api.setReceiptOrderRef(activeSlug, v.batchId, v.orderRef),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      setEditingPo(null);
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
  const confirmItemsToTheirCandidate = async (ids: Iterable<string>) => {
    const byId = new Map(items.map((i) => [i.id, i]));
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    for (const id of ids) {
      const it = byId.get(id);
      const body = it ? confirmBodyFor(it) : null;
      if (!body) {
        if (it && it.status === "pending") skipped++;
        continue;
      }
      try {
        await api.confirmScanItem(activeSlug, id, body);
        ok++;
      } catch {
        failed++;
      }
    }
    void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    const parts = [`${ok} confirmed`];
    if (skipped) parts.push(`${skipped} need a manual look`);
    if (failed) parts.push(`${failed} failed`);
    toast.success(parts.join(" · "));
    return { ok, skipped, failed };
  };
  const bulkConfirm = async () => {
    setBulkBusy(true);
    await confirmItemsToTheirCandidate(selected);
    setBulkBusy(false);
    clearSelected();
  };
  // "File all" on a session header: confirm every ready item in that session to
  // its own candidate. The button only shows once the AI is done (busy===0), so
  // routing is settled.
  const fileSession = async (ids: string[]) => {
    setBulkBusy(true);
    await confirmItemsToTheirCandidate(ids);
    setBulkBusy(false);
  };

  return (
    <div className="space-y-3 max-w-4xl mx-auto">
      {/* ── the ONE header row: identity + intake. Short word labels;
            compact paddings keep it one row on phones. ──────────────── */}
      {/* flex-wrap at every size: the identity chips are all shrink-0, so
          without wrapping the two clusters OVERLAP at mid widths (~1500px
          with several chips visible). Wrapping drops intake to its own row
          exactly when it needs one. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap border-b border-line dark:border-slate-700 pb-2.5">
        {/* identity — title, count, review/session chips */}
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
        <h1 className="text-lg font-semibold text-content dark:text-mortar-100 shrink-0">
          Inbox
        </h1>
        <span className="text-sm text-muted dark:text-slate-400 shrink-0">
          {totalPending}
          <span className="hidden sm:inline"> pending</span>
        </span>
        {/* The two lenses on the same pending items: by scan session, or by
            destination (the sorting plan). Only worth offering when there's a
            backlog to sort. */}
        {(unfiledCount > 0 || readyCount > 0) && (
          <div className="inline-flex items-center rounded-full border border-line dark:border-slate-700 p-0.5 text-xs shrink-0">
            {(
              [
                ["sessions", "By session"],
                ["plan", "Sorting plan"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                aria-pressed={viewMode === mode}
                className={
                  "rounded-full px-2.5 py-0.5 transition " +
                  (viewMode === mode
                    ? "bg-cobble-600 text-white font-medium"
                    : "text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-100")
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {reviewCount > 0 && (
          <button
            type="button"
            onClick={() => setReviewOnly((v) => !v)}
            title="Show only items that didn't cleanly resolve"
            className={
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs shrink-0 transition " +
              (reviewOnly
                ? "border-amber-500 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
                : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:border-amber-400")
            }
          >
            ⚠ {reviewCount} need{reviewCount === 1 ? "s" : ""} review
          </button>
        )}
        <div className="relative inline-flex items-center shrink-0">
          <Search size={12} className="absolute left-2 text-faint pointer-events-none" />
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="search inbox…"
            aria-label="Search the pending queue"
            className="w-36 sm:w-44 rounded-full border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 pl-7 pr-6 py-0.5 text-xs text-content focus:border-accent outline-none"
          />
          {searchQ && (
            <button
              type="button"
              onClick={() => setSearchQ("")}
              aria-label="Clear search"
              className="absolute right-1.5 text-faint hover:text-content"
            >
              <X size={11} />
            </button>
          )}
        </div>
        {searchTokens.length > 0 && (
          <span className="text-[11px] text-muted shrink-0">
            {visibleItems.length} / {items.length}
          </span>
        )}
        {staleCount > 0 && (
          <button
            type="button"
            onClick={() => setStaleOnly((v) => !v)}
            title="Items that have been waiting over two days"
            className={
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs shrink-0 transition " +
              (staleOnly
                ? "border-amber-500 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
                : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:border-amber-400")
            }
          >
            🕰 {staleCount} waiting 2d+
          </button>
        )}
        <button
          type="button"
          onClick={toggleGalleryView}
          title={galleryView ? "List view" : "Gallery view — big photo tiles"}
          className="inline-flex items-center gap-1 rounded-full border border-line dark:border-slate-700 px-2 py-0.5 text-xs text-muted dark:text-slate-400 hover:border-accent shrink-0"
        >
          <LayoutGrid size={12} className={galleryView ? "text-accent" : ""} />
          {galleryView ? "gallery" : "list"}
        </button>
        <button
          type="button"
          onClick={() =>
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
          title="Find catalog photos for named items that don't have one"
          className="inline-flex items-center gap-1 rounded-full border border-line dark:border-slate-700 px-2 py-0.5 text-xs text-muted dark:text-slate-400 hover:border-accent shrink-0"
        >
          <ImageIcon size={12} /> fill photos
        </button>
        {batchId && (
          <Link
            to="/scan"
            title="Filtered to this scan session — tap to show everything pending"
            className="inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 px-2.5 py-0.5 text-xs text-content dark:text-mortar-100 shrink-0 hover:border-cobble-400"
          >
            {(() => {
              // Name the session by its newest item's time (+ area) so the chip
              // says WHICH burst you're reviewing, not just "session".
              const newest = items[0];
              const t = newest ? Date.parse(newest.created_at) : NaN;
              const area = items.find((i) => i.scan_area)?.scan_area;
              return `session${Number.isFinite(t) ? ` · ${formatSessionTime(t)}` : ""}${area ? ` · ${area}` : ""}`;
            })()}
            <X size={12} className="text-faint" />
          </Link>
        )}
        </div>
        <div className="hidden sm:block sm:flex-1" />
        {/* intake — a horizontal-scroll strip on mobile so it NEVER overflows no
            matter how many buttons get added; a normal row on desktop. */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 -mb-1 sm:overflow-visible sm:pb-0 sm:mb-0">
        <button
          type="button"
          onClick={() => setUpcOpen(true)}
          title="Type or scan-gun a UPC"
          className={headerBtn}
        >
          <ScanLine size={15} /> UPC
        </button>
        {/* Photo intake sits SECOND (right after UPC) so it's reachable on
            mobile without scrolling the strip — and carries an image icon, not
            the Upload icon, so it can't be mistaken for the batch Import below.
            accept="image/*" + multiple → phone offers Take Photo / Photo Library
            (multi-select) / Files; a multi-select groups as one batch. */}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title="Add photos — take one now or pick several from this device; multiple photos come in as one batch"
          className={headerBtn + (uploading ? " opacity-50" : "")}
        >
          <ImageIcon size={15} />{" "}
          {uploadProgress
            ? `adding ${uploadProgress.done}/${uploadProgress.total}…`
            : uploading
              ? "adding…"
              : "Photos"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const fs = Array.from(e.target.files ?? []);
            if (fs.length) void uploadPhotos(fs);
          }}
        />
        <button
          type="button"
          onClick={() => setUrlsOpen(true)}
          title="Paste product URLs — one per line — to catalog them in bulk"
          className={headerBtn}
        >
          <ExternalLink size={15} /> URLs
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          title="Import a batch from a file — JSON/CSV inbox exports or any CSV"
          className={headerBtn}
        >
          <Upload size={15} /> Import
        </button>
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          title="Export inbox items to a file — pick which items and how photos travel (link vs baked-in)"
          className={headerBtn}
        >
          <Download size={15} /> Export
        </button>
        <button
          type="button"
          onClick={() => setOrganizeUnplacedOpen(true)}
          title="Plan homes for tracked things that have no location yet — grouped, with destination bins proposed"
          className={headerBtn}
        >
          <Wand2 size={15} /> Organize
        </button>
        <button
          type="button"
          onClick={() => setLiveSortOpen(true)}
          title="Live Sort: scan a thing, get told which bin it goes in, confirm, next — sort a pile in one pass"
          className={headerBtn}
        >
          <Zap size={15} /> Live Sort
        </button>
        <button
          type="button"
          onClick={() => receiptRef.current?.click()}
          disabled={uploading}
          title="Upload a receipt — CSV, PDF, or a photo — we'll pull out the line items"
          className={headerBtn + (uploading ? " opacity-50" : "")}
        >
          <FileText size={15} /> Receipt
        </button>
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
        <Link
          to={`/scan/camera${params.toString() ? `?${params}` : ""}`}
          title="Open the full-screen scanner"
          aria-label="Open the camera scanner"
          className="inline-flex items-center rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1.5 transition shrink-0"
        >
          <Camera size={16} />
        </Link>
        {/* Desktop (no camera) → pair a phone to scan into this same inbox.
            Renders null on touch devices, where the camera above is primary. */}
        <PairPhoneButton className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-700 text-sm text-content hover:bg-subtle dark:hover:bg-slate-800/70 px-2.5 py-1.5 transition shrink-0" />
        </div>
      </div>

      {/* Secondary intake metadata — the active filing bin (every scan files
          into this core-locations node until cleared) + the receipt drop-box
          address — packed onto ONE wrapping row so the header stays short. */}
      {(locsEnabled || receiptAddress) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm -mt-1">
          {locsEnabled && (
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="inline-flex items-center gap-1 text-muted dark:text-slate-400 shrink-0"
                title="New scans auto-file into this location as you scan. To set a location on items you've ALREADY scanned, select them and use ‘Set location’ in the toolbar."
              >
                <MapPin size={14} /> New scans →
              </span>
              <div className="min-w-0 max-w-[16rem] sm:max-w-[26rem]">
                <LocationTreePicker
                  value={fileBin || null}
                  onChange={(v) => setFileBin(v ?? "")}
                  placeholder="pick a location"
                  size="sm"
                />
              </div>
              {fileBin && (
                <button
                  type="button"
                  onClick={() => setFileBin("")}
                  className="text-xs text-faint hover:text-content dark:hover:text-mortar-100 shrink-0"
                >
                  clear
                </button>
              )}
            </div>
          )}
          {receiptAddress && (
            // sm:ml-auto pushes the receipt drop-box to the far right on a wide
            // header, freeing the middle so the location picker (widened above)
            // can show a full "Room > Bin" path instead of truncating.
            <div className="flex items-center gap-1.5 min-w-0 text-xs text-muted dark:text-slate-400 sm:ml-auto">
              <FileText size={13} className="text-faint shrink-0" />
              <span className="shrink-0">Email receipts to</span>
              {/* Capped, horizontally-scrollable chip: the long +tag address is
                  cut off so it never eats a full row, but stays fully selectable
                  and scrollable (and Copy grabs the whole thing regardless). */}
              <code className="block max-w-[8.5rem] sm:max-w-[13rem] overflow-x-auto whitespace-nowrap rounded bg-mortar-100 dark:bg-slate-800 px-1.5 py-0.5 text-content dark:text-mortar-100 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {receiptAddress}
              </code>
              <button
                type="button"
                className="shrink-0 text-accent hover:underline"
                onClick={() => {
                  void navigator.clipboard?.writeText(receiptAddress);
                  toast.success("Address copied");
                }}
              >
                Copy
              </button>
            </div>
          )}
        </div>
      )}

      <AiOffNotice status={aiStatus} />

      <ScanDrivePanel drive={scanDrive} />

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
          <div className="text-xs text-faint dark:text-slate-500 mt-1">
            Got a USB or Bluetooth barcode scanner? Just point and scan — it lands
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
          className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 px-3 py-2 text-sm"
          data-testid="putaway-strip"
        >
          <span className="min-w-0 flex-1 text-content dark:text-mortar-100">
            <span className="mr-1.5">📦</span>
            {[
              (scanStatsQ.data!.unfiled ?? 0) > 0
                ? `${scanStatsQ.data!.unfiled} scanned item${scanStatsQ.data!.unfiled === 1 ? "" : "s"} without a home`
                : null,
              (scanStatsQ.data!.ready ?? 0) > 0 ? `${scanStatsQ.data!.ready} ready to put away` : null,
            ]
              .filter(Boolean)
              .join(", and ")}
            <span className="text-muted dark:text-slate-400"> · preview first, nothing moves until you confirm</span>
          </span>
          <button
            type="button"
            onClick={() => setViewMode("plan")}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1.5 transition shrink-0"
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
          ▶ Resume put-away walk — {resumablePlan.remaining} item
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
          onStartWalk={() => void startWalk()}
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
          onStartWalk={() => {
            setOrganizeUnplacedOpen(false);
            void startWalk();
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
                toast.success("Session ended — the next scan starts a new one");
              }}
              className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
            >
              End session
            </button>
          </span>
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
            onStartWalk={() => void startWalk()}
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
                  hasLocations={hasLocations}
                  selected={selected.has(item.id)}
                  onToggleSelect={() => toggleSelected(item.id)}
                  rateLimitGaveUp={rlGaveUp.has(item.id)}
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
          if (!showSessionHeaders || !sessionGroups) return visibleItems.map(card);
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
            const pendingInSession = g.items.filter((it) => it.status === "pending").length;
            // This group IS the live scanning session (localStorage) — so it
            // carries the "active" pulse + End control that used to live in the
            // now-suppressed green banner.
            const isActiveSession = sessionActive && g.isBatch && g.batchId === activeSession?.batchId;
            return (
              <div key={g.key} id={g.batchId ? `s-${g.batchId}` : undefined} className="space-y-2 scroll-mt-24">
                <div className="flex w-full items-center gap-2 rounded-md bg-mortar-50 dark:bg-slate-800/40 px-2.5 py-1.5 text-left text-xs">
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
                    className="shrink-0 h-3.5 w-3.5 accent-cobble-600 cursor-pointer"
                  />
                  <button
                    type="button"
                    onClick={() => toggleSession(g.key)}
                    className="flex flex-1 min-w-0 items-center gap-2 text-left"
                  >
                    <ChevronDown size={13} className={`shrink-0 transition ${collapsed ? "-rotate-90" : ""}`} />
                    <span className="font-medium text-content dark:text-mortar-100 truncate">
                      {g.label ?? `Session · ${formatSessionTime(g.latest)}`}
                    </span>
                    {g.label && (
                      <span className="shrink-0 text-faint">
                        {g.origin === "email" ? "emailed " : ""}
                        {formatSessionTime(g.latest)}
                      </span>
                    )}
                    {isActiveSession && (
                      <span
                        className="inline-flex items-center gap-1 shrink-0 text-emerald-600/80 dark:text-emerald-400/80"
                        title="The live scanning session — new scans keep grouping here until 30 min idle"
                      >
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        active
                      </span>
                    )}
                    {g.lastTouched - g.latest > 6 * 3600_000 && (
                      <span
                        className="text-faint truncate"
                        title="A later change (a fix, or an item sent back from a commit) — the session's own time is unchanged"
                      >
                        · edited {timeAgo(new Date(g.lastTouched).toISOString())}
                      </span>
                    )}
                    {g.area && <span className="text-muted truncate">· {g.area}</span>}
                    <span className="ml-auto shrink-0 text-faint">
                      {g.items.length} item{g.items.length === 1 ? "" : "s"}
                    </span>
                  </button>
                  {/* The session's action slot — its state used to be a passive
                      "All set" check that read as "committed" but only collapsed
                      the row on click (a user filed nothing and thought they had,
                      2026-07-16). Now: a real "File all" BUTTON once the AI is done,
                      committing every ready item to its own destination. */}
                  {busy > 0 ? (
                    <span
                      className="shrink-0 inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                      title="The AI is still finalizing some items — names, covers and routing may still change"
                    >
                      <Loader2 size={9} className="animate-spin" /> {busy} finishing…
                    </span>
                  ) : readyIds.length > 0 ? (
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void fileSession(readyIds);
                      }}
                      title={`Add all ${readyIds.length} to their destinations — each goes where the AI matched it`}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 px-2 py-1 text-[11px] font-medium text-white"
                    >
                      <CheckCircle size={11} /> File all {readyIds.length}
                    </button>
                  ) : pendingInSession > 0 ? (
                    <span
                      className="shrink-0 inline-flex items-center gap-1 text-amber-600/80 dark:text-amber-400/80 text-[10px] font-medium"
                      title="Every item still here needs a manual look — open the cards to give each a name or destination"
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
                  {g.sourceFileId && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setViewSource(g.sourceFileId);
                      }}
                      title="View the original receipt this was parsed from"
                      className="shrink-0 inline-flex items-center gap-1 text-faint hover:text-accent"
                    >
                      <FileText size={11} /> Original
                    </button>
                  )}
                  {/* Edit the order/invoice #. Gated on a RECEIPT session (by label,
                      so pre-source-storage sessions get it too), not sourceFileId. */}
                  {g.isBatch && g.batchId && g.label?.startsWith("Receipt") &&
                    (editingPo === g.batchId ? (
                      <span onClick={(e) => e.stopPropagation()} className="shrink-0 inline-flex items-center gap-1">
                        <span className="text-faint">#</span>
                        <input
                          autoFocus
                          value={poInput}
                          onChange={(e) => setPoInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") setOrderRef.mutate({ batchId: g.batchId!, orderRef: poInput.trim() || null });
                            else if (e.key === "Escape") setEditingPo(null);
                          }}
                          placeholder="order #"
                          className="w-24 bg-transparent border-b border-cobble-400 dark:border-cobble-600 text-content dark:text-mortar-100 text-sm px-0.5 focus:outline-none"
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
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPoInput(g.orderRef ?? "");
                          setEditingPo(g.batchId!);
                        }}
                        title={g.orderRef ? "Edit the order / invoice number" : "Add an order / invoice number"}
                        className="shrink-0 inline-flex items-center gap-1 text-faint hover:text-accent"
                      >
                        <Pencil size={11} /> {g.orderRef ? "PO#" : "+ PO#"}
                      </button>
                    ))}
                  {g.sourceFileId && g.batchId && (
                    <button
                      type="button"
                      disabled={reparse.isPending && reparseBatch === g.batchId}
                      onClick={(e) => {
                        e.stopPropagation();
                        reparse.mutate(g.batchId!);
                      }}
                      title="Re-run the parser on the original receipt (replaces the pending lines)"
                      className="shrink-0 inline-flex items-center gap-1 text-faint hover:text-accent disabled:opacity-50"
                    >
                      <RotateCcw size={11} className={reparse.isPending && reparseBatch === g.batchId ? "animate-spin" : ""} /> Re-parse
                    </button>
                  )}
                  {g.isBatch && g.batchId && (
                    <Link
                      to={`/scan?batch=${g.batchId}`}
                      title="Review just this session"
                      className="shrink-0 text-faint hover:text-accent"
                    >
                      open →
                    </Link>
                  )}
                  {isActiveSession && (
                    <button
                      type="button"
                      title="End this scan session — the next scan starts a new one"
                      onClick={() => {
                        clearScanSession(activeSlug);
                        toast.success("Session ended — the next scan starts a new one");
                      }}
                      className="shrink-0 text-faint hover:text-accent"
                    >
                      End
                    </button>
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
                hasLocations={hasLocations}
                rateLimitGaveUp={rlGaveUp.has(focus.id)}
                defaultExpanded
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
                          <div className="text-[10px] font-mono text-faint truncate">
                            {d.target_kind ? `→ ${d.target_kind}` : ""}
                            {d.barcode_text ? ` · ${d.barcode_text}` : ""}
                          </div>
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
                        <div className="text-[10px] font-mono text-faint truncate">
                          {grp.items[0].target_kind ? `→ ${grp.items[0].target_kind}` : ""}
                          {grp.items[0].barcode_text ? ` · ${grp.items[0].barcode_text}` : ""}
                        </div>
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
      {upcOpen && <UpcModal onClose={() => setUpcOpen(false)} />}
      {urlsOpen && <UrlsModal onClose={() => setUrlsOpen(false)} />}
      {viewSource && (
        <ReceiptSourceViewer slug={activeSlug} fileId={viewSource} onClose={() => setViewSource(null)} />
      )}
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
    mutationFn: async (value: string) =>
      api.scanBarcode(activeSlug, {
        barcode: value.trim(),
        // Same time-gap session the wedge/camera use — typed UPCs join the burst.
        scan_batch_id:
          (await resolveSessionBatch(activeSlug, () =>
            api.createScanBatch(activeSlug).then((b) => b.id).catch(() => null),
          )) ?? undefined,
      }),
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

// Bulk URL intake: paste product URLs (one per line) — each becomes an inbox item
// enriched through the URL path (vendor resolver → web search). For cataloging an
// order/wishlist without a barcode.
function UrlsModal({ onClose }: { onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const urls = text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/\S+$/i.test(s))
    .slice(0, 50);

  const submit = async () => {
    if (!urls.length) return;
    setBusy(true);
    let ok = 0;
    for (const url of urls) {
      try {
        await api.scanBarcode(activeSlug, { source_kind: "url", source_url: url });
        ok++;
      } catch {
        /* skip bad ones; summary reflects what landed */
      }
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    toast.success(`Added ${ok} URL${ok === 1 ? "" : "s"} — identifying in the inbox.`);
    onClose();
  };

  return (
    <Modal open onClose={onClose} title="Paste product URLs" size="sm">
      <div className="space-y-2">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"One URL per line\nhttps://www.example.com/product/123\nhttps://…"}
          rows={6}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 font-mono"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted dark:text-slate-400">
            {urls.length} URL{urls.length === 1 ? "" : "s"} detected{urls.length === 50 ? " (max)" : ""}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            disabled={busy || urls.length === 0}
            onClick={() => void submit()}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
          >
            {busy ? "Adding…" : `Add ${urls.length || ""}`}
          </button>
        </div>
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
  selected,
  onToggleSelect,
  rateLimitGaveUp,
  defaultExpanded,
  planContext,
}: {
  item: ScanInboxItem;
  pageTarget: ScanTarget | null;
  menu: ScanMenuEntry[] | null;
  hasLocations: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  rateLimitGaveUp?: boolean;
  /** Open pre-expanded (the gallery view's focus modal). */
  defaultExpanded?: boolean;
  /** Rendered INSIDE an organize plan's accordion: the card is an identity
   *  FIXER there (name, photo, AI hint/rerun), never a commit surface —
   *  confirming into a table mid-plan yanks the item out of the plan (the
   *  trap the author hit). Hides the confirm form, table chips, and
   *  discard; the accordion owns collapse. */
  planContext?: boolean;
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
  // Re-arm the OPEN form when a re-run lands a new answer. `formCtx` (which drives
  // ADD TO + the pre-filled fields) is only set by openForm() on a CLICK, so a
  // re-run updated the header chips and the Source panel while the form below kept
  // the previous run's route + category until the user closed and reopened the
  // card (the author, 2026-07-17: re-identified a miter-saw misread as a tool tote, but
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
    if (expanded && !planContext) openForm(topCand ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerSig]);
  // Stuck-nameless: enrichment finished (ai_suggested_at) but produced no name
  // and no candidates — a bare photo that couldn't be auto-identified. Offer the
  // manual "name it" entry instead of an endless "AI is reading…" pulse.
  const needsName =
    item.status === "pending" &&
    !item.suggested_name &&
    !!item.ai_suggested_at &&
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
  // Still worth a "retrying…" pulse only while retries remain; once spent (a
  // persistent rate-limit like the daily upcitemdb quota), it's terminal.
  const rlActive = rateLimited && !rateLimitGaveUp;
  // Couldn't auto-identify → offer manual naming. Either enrichment finished
  // empty (needsName) or the rate-limit retries are spent (rateLimitGaveUp).
  const cantIdentify = needsName || (rateLimited && !!rateLimitGaveUp);
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
  const barcodeIdentified = !!item.barcode_text && !!item.suggested_name;
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
          await api.restoreScanItem(activeSlug, item.id);
          void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
          void qc.invalidateQueries({ queryKey: ["scan-inbox-discarded", activeSlug] });
        },
      });
    },
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
  const canInstallBundle = activeOrg?.role === "owner" || activeOrg?.role === "admin";
  const topBundle = canInstallBundle && topCand?.bundle_external_id ? topCand : null;
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
  const quickConfirmReady =
    !!topCand &&
    !!item.suggested_name &&
    !alreadyTracked &&
    (!topCand.bundle_external_id || !!topBundle);
  const quickConfirm = useMutation({
    mutationFn: async () => {
      if (!topCand || !item.suggested_name) throw new Error("not ready to confirm");
      // Install the bundle first (no item_ids = install-only) so its table
      // exists, then file into it — the same install-then-add the form's Confirm
      // runs, but with the scan's values as-is (open the card to edit them).
      if (topCand.bundle_external_id) {
        await api.materializeQuickstart(activeSlug, topCand.bundle_external_id, { item_ids: [] });
      }
      const meta = (item.suggested_metadata as Record<string, unknown> | null) ?? {};
      const serial = String((meta as { serial_number?: unknown }).serial_number ?? "");
      const extras = {
        ...(item.suggested_manufacturer ? { manufacturer: item.suggested_manufacturer } : {}),
        ...(serial ? { serial_number: serial } : {}),
        ...(topCand.fields && Object.keys(topCand.fields).length ? { metadata: topCand.fields } : {}),
      };
      return api.confirmScanItem(activeSlug, item.id, {
        target_module: topCand.module,
        target_kind: baseKind(topCand.module),
        instance: topCand.instance ?? undefined,
        name: item.suggested_name,
        quantity: item.quantity ?? topCand.quantity ?? undefined,
        location_id: item.target_location_id ?? undefined,
        extras: Object.keys(extras).length ? extras : undefined,
      });
    },
    onSuccess: () => {
      toast.success(
        topCand?.bundle_external_id
          ? `Installed ${topCand.label} — added ${item.suggested_name}`
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
    mutationFn: (vars?: { hint?: string; wrong?: boolean; enrich?: boolean; noAi?: boolean }) =>
      api.rerunScanAi(activeSlug, item.id, {
        hint: vars?.hint,
        wrong: vars?.wrong,
        enrich: vars?.enrich,
        noAi: vars?.noAi,
      }),
    onMutate: () => {
      if (isPhotoItem) {
        readingSnapshot.current = item.ai_suggested_at ?? null;
        setReading(true);
      }
    },
    onSuccess: (fresh, vars) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      if (vars?.noAi) {
        toast.success("Replaying the cached read through the current code…");
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
        toast.success("Re-checking — the name updates in a moment…");
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
      toast.success("Locked into the barcode database — future scans of this code get this listing.");
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
  // "Replay (no AI)" runs the SAME mutation with noAi — but showing it as
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
  const catalogImg = useImageSrc(catalogUrl);
  const yoursImg = useImageSrc(yoursUrl);
  // While a barcode's catalog image is UNVERIFIED — being checked against your
  // photo, or already flagged a mismatch — lead with YOUR photo, not the catalog
  // one. A barcode can resolve to a wrong/spam product (an action figure, a
  // lookup-site screenshot) whose race-fetched image reads as "the scan failed";
  // your own photo is never wrong. Once the check confirms, the catalog image
  // (a clean product shot) leads again.
  const photoUnverified = !!(
    item.suggested_metadata as { photo_check_pending?: boolean; photo_mismatch?: unknown } | null
  )?.photo_check_pending || !!(item.suggested_metadata as { photo_mismatch?: unknown } | null)?.photo_mismatch;
  const thumb = photoUnverified ? (yoursImg ?? catalogImg) : (catalogImg ?? yoursImg);

  // Image viewer: click to zoom (the shared ImageLightbox — same viewer as the
  // web-photo "view full size"), revert the catalog image to the original
  // (preserved server-side on the first override), or use your own scan photo as
  // the catalog image. ONE filmstrip regardless of which image you click: the
  // item's own shots (catalog + yours, already-resolved blob urls above) followed
  // by the web photo candidates — so opening from the catalog shows the same
  // options as opening from a web tile (the author, 2026-07-24). The candidates are
  // fetched by the PhotoOptions strip below and reported up via onItems.
  const [zoomIdx, setZoomIdx] = useState<number | null>(null);
  const [photoCandidates, setPhotoCandidates] = useState<ImageOption[]>([]);
  const zoomItems: LightboxItem[] = [
    ...(catalogImg ? [{ key: "catalog", caption: "Catalog image", url: catalogImg }] : []),
    ...(yoursImg && yoursImg !== catalogImg ? [{ key: "yours", caption: "Your photo", url: yoursImg }] : []),
    ...photoCandidates.map((o) => ({
      key: o.url,
      caption: `${o.title} · ${o.source}`,
      href: o.source,
      url: o.url,
      thumbUrl: o.thumb,
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
    mutationFn: (url: string) => api.setScanCatalogImage(activeSlug, item.id, url),
    onSuccess: () => {
      toast.success("Catalog photo updated");
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const hasOrigCatalog = !!(item.suggested_metadata as { orig_catalog?: unknown } | null)?.orig_catalog;
  const catalogAction = useMutation({
    mutationFn: (action: "revert" | "use_own_photo") => api.scanCatalogAction(activeSlug, item.id, action),
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
    if (!m.photo_distinct || m.photo_distinct < 2) return null;
    if (m.keep_grouped || m.split_from || m.split_into) return null;
    if (item.status !== "pending") return null;
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
    mutationFn: (b: Blob) =>
      api.uploadFile(activeSlug, toFile(b, "photo")).then((up) => api.addScanPhoto(activeSlug, item.id, up.id)),
    onSuccess: () => {
      setCaptureSheet(null);
      toast.success("Photo added");
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
  const extraPhotos = Array.isArray((item.suggested_metadata as { extra_photos?: unknown })?.extra_photos)
    ? ((item.suggested_metadata as { extra_photos: string[] }).extra_photos)
    : [];
  // Box-state: unset → empty-box → item-in-box → unset.
  const boxState =
    (item.suggested_metadata as { box_state?: "item-in-box" | "empty-box" } | null)?.box_state ?? null;
  const cycleBoxState = useMutation({
    mutationFn: () =>
      api.updateScanItem(activeSlug, item.id, {
        box_state: boxState === null ? "empty-box" : boxState === "empty-box" ? "item-in-box" : null,
      }),
    onSuccess: invalidateInbox,
    onError: onErr,
  });
  // "Looks fine" — human eyeballed a flagged item; drop it from needs-review.
  const alreadyReviewed = !!(item.suggested_metadata as { reviewed?: boolean } | null)?.reviewed;
  const flaggedForReview =
    item.status === "pending" &&
    !alreadyReviewed &&
    (!item.suggested_name ||
      lowTrust ||
      rateLimited ||
      (item.ai_confidence != null && Number(item.ai_confidence) < 0.5));
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
        onClick={() => (expanded ? setExpanded(false) : openForm())}
      >
        {/* Photo column: a CONSISTENT WIDTH (so every card's text starts at the
            same x), stretched to the row's full height — a book cover / product
            shot reads far better big. Wider now (the select checkbox moved ONTO
            it as a top-left overlay, freeing its old column), and object-CONTAIN
            so a tall bottle/tub shows in full instead of a cropped centre strip.
            min-h keeps a short card's image sensible. */}
        <div className="relative w-28 shrink-0 self-stretch min-h-[4.5rem] rounded-l-xl border-r border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 flex items-center justify-center overflow-hidden">
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
          <div className="font-medium text-content dark:text-mortar-100 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            {item.suggested_name ? (
              <>
                <span className="break-words min-w-0 max-w-full">{item.suggested_name}</span>
                {rerunning || serverMatching ? (
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-accent animate-pulse">
                    {replayNoAi ? "replaying (no AI)" : rerunning ? "re-running" : "AI reading…"}
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
                {replayNoAi ? "Replaying from cached data (no AI)…" : "Re-running the lookup…"}
              </span>
            ) : serverMatching ? (
              <span className="text-accent animate-pulse">
                {replayNoAi ? "Replaying from cached data (no AI)…" : "AI is reading the details…"}
              </span>
            ) : rlActive ? (
              <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <Loader2 size={13} className="animate-spin shrink-0" />
                Rate-limited — retrying…
              </span>
            ) : cantIdentify ? (
              <span className="text-muted">Couldn’t identify this {idNoun} — name it:</span>
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
          <div className="text-[11px] font-mono text-faint dark:text-slate-500 truncate">
            {(() => {
              // Build the subtitle from the fields that are PRESENT and join them
              // with " · ". An absent field (a photo-identified book has no
              // barcode/ISBN) must not leave a dangling leading separator — that
              // reads as "something's missing here". Never a leading/trailing dot.
              const segs: ReactNode[] = [];
              if (item.barcode_text) {
                const aiRead =
                  (item.suggested_metadata as { barcode_source?: string } | null)?.barcode_source === "ai-photo";
                segs.push(
                  <>
                    {item.barcode_text}
                    {aiRead && <span className="text-amber-600 dark:text-amber-500"> (read from photo)</span>}
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
          {!expanded && item.ai_notes && (
            <div
              className={`text-[11px] mt-0.5 line-clamp-1 ${
                rateLimited || lowTrust ? "text-amber-600 dark:text-amber-400" : "text-muted"
              }`}
            >
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
              title="Rename to what the photo shows — and report the barcode fix"
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
          {cantIdentify && <NameItInline slug={activeSlug} itemId={item.id} />}
          {/* One-tap correction: a barcode whose name looks wrong (always
              available, nudged for low-trust short codes). Renaming reports the
              fix to the shared Barcode Intelligence DB so the next scan is right. */}
          {barcodeIdentified &&
            !expanded &&
            (correcting ? (
              <CorrectNameInline
                slug={activeSlug}
                itemId={item.id}
                initial={item.suggested_name ?? ""}
                onDone={() => setCorrecting(false)}
              />
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setCorrecting(true);
                }}
                className={`mt-0.5 text-[11px] underline decoration-dotted underline-offset-2 ${
                  lowTrust
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-faint hover:text-amber-600 dark:hover:text-amber-400"
                }`}
              >
                {lowTrust ? "Double-check — fix the name" : "Not right? Fix the name"}
              </button>
            ))}
          {/* "You already have one of these" — its OWN line, because the answer
              has to NAME the record. As an action segment on the route chip it
              read "Vehicles | Same one?", which can't say same as WHAT (the author,
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
                  <span className="text-muted dark:text-slate-400"> — is this the same one?</span>
                </span>
              </span>
              <button
                type="button"
                onClick={() => (topCand ? openForm(topCand) : setExpanded(true))}
                className="shrink-0 inline-flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 text-[11px] font-medium transition"
              >
                Compare &amp; merge
              </button>
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
              {candidates.map((c, i) =>
                i === 0 ? (
                  // The PRIMARY route is a SPLIT chip (the location picker's
                  // grammar): the body opens the review form; the emerald
                  // "✓ Add" segment commits as-is into this table. The commit
                  // used to be an unlabeled green checkmark in the card's icon
                  // rail — unreadable, and hover-only context doesn't exist on
                  // a phone (the author). Attached to its destination, labeled.
                  <span
                    key={`${c.module}:${c.instance ?? ""}:${i}`}
                    className="inline-flex max-w-full items-stretch rounded-full overflow-hidden border border-cobble-600 bg-cobble-600 text-white text-xs font-medium"
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openForm(c);
                      }}
                      title={
                        Object.keys(c.fields).length
                          ? `Review & edit — fills: ${Object.entries(c.fields).map(([k, v]) => `${k}=${v}`).join(", ")}`
                          : `Review & add to ${c.label}`
                      }
                      className="inline-flex min-w-0 items-center gap-1 pl-2.5 pr-2 py-1 hover:bg-cobble-700 transition"
                    >
                      <Sparkles size={11} className="shrink-0" />
                      <span className="truncate">{c.label}</span>
                    </button>
                    {quickConfirmReady && !topBundle && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          quickConfirm.mutate();
                        }}
                        disabled={quickConfirm.isPending}
                        title={`Add to ${c.label} as shown — no need to open it`}
                        className="inline-flex shrink-0 items-center gap-1 border-l border-white/25 bg-emerald-600 hover:bg-emerald-500 pl-2 pr-2.5 py-1 transition disabled:opacity-60"
                      >
                        <CheckCircle size={11} className={`shrink-0 ${quickConfirm.isPending ? "animate-pulse" : ""}`} />
                        {quickConfirm.isPending ? "Adding…" : "Add"}
                      </button>
                    )}
                    {/* A match doesn't get an action segment here: "Same one?"
                        next to a TABLE name can't say same as WHAT (the author,
                        2026-07-16). It gets its own line above, which can name
                        the record. The chip stays a plain route, and the
                        duplicate-making one-tap Add simply isn't offered. */}
                  </span>
                ) : (
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
                    className="max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition border hidden sm:inline-flex bg-subtle dark:bg-slate-800 hover:bg-line dark:hover:bg-slate-700 text-content dark:text-mortar-200 border-line dark:border-slate-700"
                  >
                    <Sparkles size={11} className="shrink-0" />
                    <span className="truncate">{c.label}</span>
                  </button>
                ),
              )}
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
                  // much width as the field chip it hides (the author, 2026-07-18).
                  const MAX = 6;
                  const shown = entries.length <= MAX + 1 ? entries : entries.slice(0, MAX);
                  const extra = entries.length - shown.length;
                  return (
                    <>
                      {shown.map(([k, v]) => (
                        <span
                          key={k}
                          className="inline-flex items-center gap-1 rounded-md bg-subtle/60 dark:bg-slate-800/60 border border-line/70 dark:border-slate-700/70 px-1.5 py-0.5 text-[11px] text-content dark:text-mortar-200 min-w-0"
                          title={`${menuFieldLabel(menu, topCand, k)}: ${String(v)}`}
                        >
                          <span className="text-faint shrink-0">{menuFieldLabel(menu, topCand, k)}</span>
                          <span className="truncate">{String(v)}</span>
                        </span>
                      ))}
                      {extra > 0 && (
                        <span
                          className="text-[11px] text-faint shrink-0 px-1"
                          title={entries.slice(MAX).map(([k, v]) => `${menuFieldLabel(menu, topCand, k)}: ${v}`).join(", ")}
                        >
                          +{extra}
                        </span>
                      )}
                    </>
                  );
                })()}
            </div>
          )}
          {candidates.length === 0 && serverMatching && (
            <div className="text-[11px] text-faint italic mt-1">finding the best table…</div>
          )}
          {/* Install CTA on the CLOSED card — the top match is a bundle you don't
              have (a scanned VIN → Vehicles), and most people won't open the
              accordion. One tap installs its table + files this in (scan values
              as-is); "edit fields first" opens the form to adjust. */}
          {topBundle && (
            <div className="mt-2 flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => quickConfirm.mutate()}
                disabled={quickConfirm.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50"
              >
                <Download size={13} />
                {quickConfirm.isPending ? `Installing ${topBundle.label}…` : `Install ${topBundle.label} & add`}
              </button>
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
        <div className="flex flex-col items-center justify-between shrink-0 self-stretch py-2 pr-0.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => rerun.mutate(undefined)}
            // Re-run needs SOMETHING to look up again — a barcode, a photo, OR a
            // name (a receipt/note line has only a name; re-running re-does the
            // web/text lookup and can finally fetch a product image). See
            // canRerunLookup — gating on barcode||image alone greyed out receipts.
            disabled={aiWorking || !canRerunLookup(item)}
            className="text-faint hover:text-accent p-1.5 disabled:opacity-30"
            title={replayNoAi ? "Replaying (no AI)…" : aiWorking ? "AI is working…" : "Rerun lookup"}
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
          {/* "Already tracked" — attach to the existing entity
              instead of creating a duplicate. Lazy: only queried on expand. */}
          {item.status === "pending" && (
            <TrackedMatchBanner item={item} locationId={item.target_location_id} />
          )}
          <div className="grid lg:grid-cols-2 gap-3 items-start">
          <div className="space-y-2 min-w-0">
          {/* Catalog vs YOUR photo, side by side (whichever exist). */}
          {(catalogImg || yoursImg) && (
            <div className="flex gap-2">
              {catalogImg && (
                <figure className="flex-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => openZoom("catalog")}
                    title="View full size"
                    className="block w-full rounded-md overflow-hidden border border-line dark:border-slate-700 bg-white dark:bg-slate-800 aspect-square flex items-center justify-center cursor-zoom-in"
                  >
                    <img src={catalogImg} alt="catalog" className="w-full h-full object-contain" onError={() => markBroken(catalogUrl)} />
                  </button>
                  <figcaption className="text-[10px] font-mono uppercase tracking-widest text-accent mt-1">
                    ✦ catalog
                  </figcaption>
                </figure>
              )}
              {yoursImg && yoursImg !== catalogImg && (
                <figure className="flex-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => openZoom("yours")}
                    title="View full size"
                    className="block w-full rounded-md overflow-hidden border border-line dark:border-slate-700 bg-black aspect-square flex items-center justify-center cursor-zoom-in"
                  >
                    <img src={yoursImg} alt="your photo" className="w-full h-full object-contain" onError={() => markBroken(yoursRawUrl)} />
                  </button>
                  <figcaption className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mt-1">
                    yours
                  </figcaption>
                </figure>
              )}
            </div>
          )}
          {/* Extra photos (multi-photo gallery): tap → make primary; × → remove. */}
          {extraPhotos.length > 0 && (
            <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
              {extraPhotos.map((pid) => (
                <ExtraPhotoThumb
                  key={pid}
                  slug={activeSlug}
                  fileId={pid}
                  onMakePrimary={() => setPrimaryPhoto.mutate(pid)}
                  onRemove={() => removeExtraPhoto.mutate(pid)}
                  busy={setPrimaryPhoto.isPending || removeExtraPhoto.isPending}
                />
              ))}
            </div>
          )}
          {/* Image tools: rotate / split / retake / add — plus catalog revert. */}
          <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
            {hasOrigCatalog && (
              <button
                type="button"
                disabled={catalogAction.isPending}
                onClick={() => catalogAction.mutate("revert")}
                className="text-[11px] rounded border border-line dark:border-slate-700 px-2 py-0.5 text-muted hover:text-content hover:border-accent transition disabled:opacity-50"
              >
                ↺ Revert to original
              </button>
            )}
            {yoursImg && yoursImg !== catalogImg && (
              <button
                type="button"
                disabled={catalogAction.isPending}
                onClick={() => catalogAction.mutate("use_own_photo")}
                className="text-[11px] rounded border border-line dark:border-slate-700 px-2 py-0.5 text-muted hover:text-content hover:border-accent transition disabled:opacity-50"
              >
                Use my photo
              </button>
            )}
            {item.image_file_id && (
              <button
                type="button"
                disabled={rotate.isPending}
                onClick={() => rotate.mutate()}
                title="Rotate your photo 90°"
                className="text-[11px] rounded border border-line dark:border-slate-700 px-2 py-0.5 text-muted hover:text-content hover:border-accent transition disabled:opacity-50"
              >
                {rotate.isPending ? "Rotating…" : "⟳ Rotate"}
              </button>
            )}
            {item.image_file_id && item.status === "pending" && (
              <button
                type="button"
                disabled={split.isPending}
                onClick={() => split.mutate()}
                title="Several different things in one photo? Split them into separate items"
                className="text-[11px] rounded border border-line dark:border-slate-700 px-2 py-0.5 text-muted hover:text-content hover:border-accent transition disabled:opacity-50"
              >
                {split.isPending ? "AI is splitting…" : "✂ Split into items"}
              </button>
            )}
            <button
              type="button"
              disabled={retakeCatalog.isPending}
              onClick={() => setCaptureSheet("retake")}
              title="Take a nice picture — it becomes the catalog/display photo"
              className="text-[11px] rounded border border-line dark:border-slate-700 px-2 py-0.5 text-muted hover:text-content hover:border-accent transition disabled:opacity-50"
            >
              {retakeCatalog.isPending ? "Uploading…" : "📷 Retake for catalog"}
            </button>
            <button
              type="button"
              disabled={addPhoto.isPending}
              onClick={() => setCaptureSheet("add")}
              title="Add another photo to this item"
              className="text-[11px] rounded border border-line dark:border-slate-700 px-2 py-0.5 text-muted hover:text-content hover:border-accent transition disabled:opacity-50"
            >
              {addPhoto.isPending ? "Uploading…" : "+ Add photo"}
            </button>
            {item.status === "pending" && (
              <button
                type="button"
                disabled={cycleBoxState.isPending}
                onClick={() => cycleBoxState.mutate()}
                title="Is this the item, or an empty box you keep? (tap to cycle)"
                className={`text-[11px] rounded border px-2 py-0.5 transition disabled:opacity-50 ${
                  boxState
                    ? "border-accent text-accent"
                    : "border-line dark:border-slate-700 text-muted hover:text-content hover:border-accent"
                }`}
              >
                📦 {boxState === "empty-box" ? "empty box" : boxState === "item-in-box" ? "item in box" : "box state"}
              </button>
            )}
            {flaggedForReview && (
              <button
                type="button"
                disabled={markReviewed.isPending}
                onClick={() => markReviewed.mutate()}
                title="A human looked — this one's fine; stop flagging it"
                className="text-[11px] rounded border border-emerald-400/60 px-2 py-0.5 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition disabled:opacity-50"
              >
                ✓ Looks fine
              </button>
            )}
            <CameraCaptureSheet
              open={captureSheet !== null}
              title={captureSheet === "retake" ? "Retake catalog photo" : "Add a photo"}
              busy={retakeCatalog.isPending || addPhoto.isPending}
              onCapture={(blob) => (captureSheet === "retake" ? retakeCatalog.mutate(blob) : addPhoto.mutate(blob))}
              onClose={() => setCaptureSheet(null)}
            />
          </div>
          {zoomIdx !== null && zoomItems[zoomIdx] && (
            <ImageLightbox
              items={zoomItems}
              index={zoomIdx}
              onIndex={setZoomIdx}
              onClose={() => setZoomIdx(null)}
              action={{
                // Only a web candidate can be adopted as the catalog image; the
                // item's own catalog/your-photo are view-only here (the card's
                // own buttons handle those).
                label: (it) => (it.key === "catalog" || it.key === "yours" ? null : "Use this image"),
                busy: pickCatalogImage.isPending,
                onAction: (it) => {
                  if (it.url) pickCatalogImage.mutate(it.url);
                  setZoomIdx(null);
                },
              }}
            />
          )}
          <PhotoOptions item={item} onView={openZoomUrl} onItems={setPhotoCandidates} />
          </div>
          <div className="space-y-3 min-w-0">

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
              {item.ai_notes && (
                <p className="text-xs text-muted dark:text-slate-400 mt-1">{item.ai_notes}</p>
              )}
              {/* A re-run is a gamble you can LOSE: vision re-read a dark photo of
                  a tool tote as a "Portable Bluetooth Speaker" and the good name
                  was gone, recoverable only by hand-reading the raw AI call log
                  (the author, 2026-07-17). The run snapshots what it's about to
                  overwrite, so the way back is one tap. Shown only while a
                  snapshot exists — the next run replaces it, and undoing clears it. */}
              {(() => {
                const snap = (
                  item.suggested_metadata as { pre_rerun?: { name?: string | null; kind?: string } } | null
                )?.pre_rerun;
                if (!snap || item.status !== "pending") return null;
                return (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-300/60 dark:border-amber-700/40 bg-amber-50/60 dark:bg-amber-950/20 px-2.5 py-1.5">
                    <span className="min-w-0 text-[11px] text-muted dark:text-slate-400">
                      {snap.name ? (
                        <>
                          Before this {snap.kind === "replay" ? "replay" : "re-run"} it was{" "}
                          <span className="font-medium text-content dark:text-mortar-100 break-words">{snap.name}</span>
                        </>
                      ) : (
                        <>This {snap.kind === "replay" ? "replay" : "re-run"} replaced the previous answer</>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => undoRerun.mutate()}
                      disabled={undoRerun.isPending}
                      className="shrink-0 inline-flex items-center gap-1 rounded-full border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-300 hover:bg-amber-100/70 dark:hover:bg-amber-900/30 px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50"
                    >
                      <RotateCcw size={11} className={undoRerun.isPending ? "animate-spin" : ""} />
                      {undoRerun.isPending ? "Putting it back…" : "Put it back"}
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
                  replay: "Replayed from cached data (no AI)",
                  "rerun-hint": "Re-ran with a hint",
                  wrong: "Flagged wrong — re-checked everything",
                  enrich: "Asked for more detail",
                  confirm: "Locked into the barcode database",
                  combine: "Combined similar items",
                  "undo-rerun": "Undid the re-run",
                };
                return (
                  <div className="mt-2 border-t border-line dark:border-slate-700/60 pt-1.5">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">history</div>
                    <ul className="space-y-0.5">
                      {[...hist].reverse().map((h, i) => (
                        <li key={i} className="text-[11px] text-muted dark:text-slate-400 flex items-baseline gap-2">
                          <span className="min-w-0">
                            {label[h.action] ?? h.action}
                            {h.note ? `: “${h.note}”` : ""}
                          </span>
                          <span className="text-faint ml-auto whitespace-nowrap">{timeAgo(h.at)}</span>
                        </li>
                      ))}
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
          />
          </div>
          </div>

          {/* The inline confirm form — full width below (the right-rail
              attempt collided labels at every width; reverted per the author).
              NEVER in plan context: committing mid-plan removes the item from
              the plan — fixing identity is the only job here. */}
          {!planContext && <ConfirmForm
            key={`${item.id}:${formCtx.selKey ?? "auto"}:${item.suggested_name ?? ""}:${item.suggested_manufacturer ?? ""}:${item.ai_suggested_at ?? ""}:${topCand ? topCand.label + JSON.stringify(topCand.fields) + (topCand.quantity ?? "") : "none"}`}
            item={item}
            menu={menu}
            candidates={candidates}
            hasLocations={hasLocations}
            initialKey={formCtx.selKey}
            prefill={formCtx.prefill}
            onDone={() => setExpanded(false)}
            onCancel={() => setExpanded(false)}
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
  const raw =
    item.catalog_image_file_id
      ? `/api/v1/orgs/${slug}/modules/core-files/files/${item.catalog_image_file_id}/raw?variant=med`
      : (item.catalog_image_url ??
        (item.image_file_id
          ? `/api/v1/orgs/${slug}/modules/core-files/files/${item.image_file_id}/raw?variant=med`
          : null));
  const src = useImageSrc(raw);
  const meta = (item.suggested_metadata ?? {}) as { low_trust?: boolean; rate_limited?: boolean };
  const flagged = !item.suggested_name || meta.low_trust || meta.rate_limited;
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
  busy,
}: {
  slug: string;
  fileId: string;
  onMakePrimary: () => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const src = useImageSrc(`/api/v1/orgs/${slug}/modules/core-files/files/${fileId}/raw?variant=thumb`);
  return (
    <div className="relative w-14 h-14">
      <button
        type="button"
        disabled={busy}
        onClick={onMakePrimary}
        title="Make this the primary photo"
        className="w-14 h-14 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-black flex items-center justify-center disabled:opacity-50"
      >
        {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : <ImageIcon size={16} className="text-faint" />}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onRemove}
        title="Remove this photo"
        className="absolute -top-1.5 -right-1.5 rounded-full bg-slate-700 text-white p-0.5 hover:bg-ember-600 disabled:opacity-50"
      >
        <X size={10} />
      </button>
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
}: {
  item: ScanInboxItem;
  /** A tile's ⤢ opens the CALLER's full-screen viewer at this candidate (the
   *  scan card's ONE lightbox: catalog + yours + these candidates), instead of
   *  the picker's own viewer. */
  onView?: (url: string) => void;
  /** Report the fetched candidates up so the caller can fold them into its own
   *  filmstrip. */
  onItems?: (items: ImageOption[]) => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  // The term box itself lives in the shared ImageSearchPicker; it hands the
  // typed term back via onSearch and we re-run the item's own ranked query
  // with it (the server treats a user term as an outright override).
  const [applied, setApplied] = useState("");
  const options = useQuery({
    queryKey: ["scan-photo-options", activeSlug, item.id, applied],
    queryFn: () => api.scanPhotoOptions(activeSlug, item.id, applied || undefined),
    // Only when there's a REAL name to search by — an unidentified item ("Unknown
    // Item") or a bare barcode returns junk photos, so don't even ask.
    enabled: !isUnidentified(item.suggested_name),
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
  // Report the fetched candidates up so the card's ONE lightbox can fold them
  // into its filmstrip (open from the catalog image → see the web options too).
  useEffect(() => {
    onItems?.(options.data?.items ?? []);
  }, [options.data, onItems]);
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
      onSearch={(t) => setApplied(t)}
      onPick={(url) => pick.mutate(url)}
      onPreview={onView}
      label={applied ? `results for "${applied}"` : "other photo options"}
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
}: {
  onSubmit: (hint: string, opts: { wrong?: boolean; enrich?: boolean; noAi?: boolean }) => void;
  busy: boolean;
  /** WHICH action is in flight — only that button's icon animates ("both
   *  spinners going" made a free replay read as an AI call). */
  busyKind?: "replay" | "ai" | null;
  hasBarcode: boolean;
  onConfirm: () => void;
  confirming: boolean;
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
        fire({});
      }}
      className="rounded-md border border-dashed border-line dark:border-slate-700 p-2"
    >
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1 flex items-center gap-1">
        <Sparkles size={10} className="text-accent" /> research hint
      </div>
      {/* Full-width textarea (single-line input cut the long placeholder off):
          Enter submits, Shift+Enter inserts a newline. */}
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
        placeholder="Anything that helps — a model number, a better name, a correction… (Enter to submit, Shift+Enter for a newline)"
        className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800 resize-none"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        {/* Replay — no model call, no tokens. Re-runs the pipeline's OWN code
            (reply parsers, pack-size, the split derivation, keyword routing,
            decoder role-fill, field mapping) over the model's cached answer, so
            a fix to any of that can be tried on a real item instantly and for
            free. It CANNOT test a prompt change: the cache is keyed on the image,
            not the prompt, so the cached reply answers the OLD prompt. Hidden
            when a hint is typed — a hint is new information, which needs a real
            read. */}
        {!hint.trim() && (
          <button
            type="button"
            disabled={busy}
            onClick={() => fire({ noAi: true })}
            title="Replay the cached AI reply through the current code — no model call, no tokens. Tests our parsers/heuristics/routing, NOT a prompt change."
            className="rounded border border-line dark:border-slate-600 px-2.5 py-1.5 text-sm text-muted dark:text-slate-300 hover:bg-mortar-50 dark:hover:bg-slate-800 disabled:opacity-50 shrink-0 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={13} className={busyKind === "replay" ? "animate-spin" : ""} /> Replay (no AI)
          </button>
        )}
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50 shrink-0 inline-flex items-center gap-1.5"
        >
          <RotateCcw size={13} className={busyKind === "ai" ? "animate-spin" : ""} /> {hint.trim() ? "Re-run with hint" : "Re-run AI"}
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
              disabled={busy}
              onClick={() => fire({ wrong: true })}
              title="Wrong product — re-check every source + the web, fix the name & photo, and correct the shared barcode database"
              className="flex-1 min-w-0 rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 px-2 py-1.5 text-sm font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <Flag size={13} className={busy ? "animate-pulse" : ""} /> This is wrong
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => fire({ enrich: true })}
              title="The product is right but the listing is sparse — re-check every source + the web to fill in the proper name, size and photo"
              className="flex-1 min-w-0 rounded border border-amber-300 dark:border-amber-700/70 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 px-2 py-1.5 text-sm font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <Sparkles size={13} className={busy ? "animate-pulse" : ""} /> Right — needs detail
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
              <CheckCircle size={13} className={confirming ? "animate-pulse" : ""} /> This is good — lock it in
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
  // the tap (that's the "1 of 9 isn't tagged yet" straggler the author hit: he tagged
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
  const { activeSlug, activeOrg } = useActiveOrg();
  const { user } = useAuth();
  const isAdmin = !!user?.is_platform_admin;
  // Installing a bundle changes workspace composition → owner/admin only (the
  // materialize endpoint enforces this). Gate the install-and-add card on it so
  // an editor doesn't hit a 403 dead-end; they still get the normal picker.
  const canInstallBundle = activeOrg?.role === "owner" || activeOrg?.role === "admin";
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
      if (willInstall) {
        await api.materializeQuickstart(activeSlug, willInstall, { item_ids: [] });
      }
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
          {willInstall ? `Installed ${entry.label} — added ` : "Created — open "}
          <a href={`/w/${activeSlug}${dest}`} className="underline">
            {r.item.suggested_name ?? "the new entity"}
          </a>
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
      {/* The selected destination is a bundle this workspace doesn't have yet
          (a scanned VIN → "Vehicles"). It's the DEFAULT + leads the picker, its
          fields render editable + pre-filled below, and Confirm creates its table
          first. A slim note makes that clear; picking another table opts out. */}
      {willInstall && (
        <div className="flex items-start gap-2 rounded-lg border border-accent/50 bg-accent/[0.06] dark:bg-accent/10 p-3 text-xs text-muted dark:text-slate-400">
          <Sparkles size={14} className="text-accent shrink-0 mt-0.5" />
          <span>
            You don't have <span className="font-semibold text-content dark:text-mortar-100">{entry.label}</span> yet —{" "}
            <strong>Confirm</strong> installs it (its own table + nav entry) and files this in, with the fields below. Want to
            track it another way? Pick a different table in <em>Add to</em>.
          </span>
        </div>
      )}
      <label className="block">
        <div className={labelCls}>Add to</div>
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
          className={inputCls}
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
      {parentConfig && (
        <ParentTypeCard
          slug={activeSlug}
          menu={menu}
          parent={parentConfig}
          values={{ ...customValues, manufacturer }}
          childNoun={entry.noun}
        />
      )}
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block sm:col-span-2">
          <div className={labelCls}>{fieldLabel("name", "Name")}</div>
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
          <div className={labelCls}>{fieldLabel("manufacturer", "Brand")}</div>
          <input
            type="text"
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            placeholder={item.suggested_manufacturer ?? "—"}
            className={inputCls}
          />
        </label>

        {showSerial && (
          <label className="block">
            <div className={labelCls}>{fieldLabel("serial_number", "Serial number")}</div>
            <input
              type="text"
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              placeholder={capturedSerial || "—"}
              className={`${inputCls} font-mono`}
            />
          </label>
        )}

        {/* "From the label" — everything the resolver parsed that ISN'T a
            field on this table (so the user sees the info was captured even
            though there's no box for it here — e.g. a spool's material/colour/
            temps, which ride onto its linked filament TYPE via the auto-lift).
            The covered keys (size, batch code…) already show filled in below. */}
        {(() => {
          const parsed = parsedScanFields(item.suggested_metadata as Record<string, unknown> | null);
          const covered = new Set(entry.fields.map((f) => f.name));
          const extra = Object.entries(parsed).filter(
            // serial_number has its own editable field above — don't also chip it.
            ([k, v]) => v != null && v !== "" && !covered.has(k) && k !== "serial_number",
          );
          if (extra.length === 0) return null;
          return (
            <div className="rounded-md border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 px-3 py-2">
              <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">
                From the label
              </div>
              <div className="flex flex-wrap gap-1.5">
                {extra.map(([k, v]) => {
                  const sw = /colou?r/i.test(k) ? colorSwatch(v) : null;
                  return (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-0.5 text-[11px]"
                  >
                    {sw && <span className="h-3 w-3 shrink-0 rounded-full border border-line dark:border-slate-600" style={{ background: sw }} />}
                    <span className="text-faint dark:text-slate-500">{humanizeKey(k)}</span>
                    <span className="font-medium text-content dark:text-mortar-100">{String(v)}</span>
                  </span>
                  );
                })}
              </div>
              <div className="mt-1.5 text-[10px] text-faint dark:text-slate-500">
                Parsed from the scan and saved with this item.
              </div>
            </div>
          );
        })()}

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
        {hasLocations && (() => {
          const selectedLoc = locationId ? (locs.data?.items ?? []).find((l) => l.id === locationId) : null;
          // A pick whose name hasn't loaded yet must not read as "no pick".
          const selLabel = selectedLoc ? (selectedLoc.short_name?.trim() || selectedLoc.name) : locationId ? "…" : null;
          return (
            <>
              <div className="block">
                <div className={labelCls}>Location (optional)</div>
                {/* A dropdown-style trigger showing the current pick; tapping opens
                    the chip drawer (rooms + bins — the same picker the bulk bar +
                    camera use) instead of dumping the whole tree inline. A pick
                    persists to the item immediately (no Confirm) and closes it. */}
                <button
                  type="button"
                  onClick={() => setLocOpen((o) => !o)}
                  className={`${inputCls} flex items-center justify-between gap-2 text-left`}
                  aria-expanded={locOpen}
                >
                  <span className={selLabel ? "inline-flex items-center gap-1.5 text-content dark:text-mortar-100" : "text-faint"}>
                    {selLabel ? <><MapPin size={13} className="shrink-0 text-accent" />{selLabel}</> : "Choose a location…"}
                  </span>
                  <ChevronDown size={15} className={`shrink-0 text-faint transition ${locOpen ? "rotate-180" : ""}`} />
                </button>
              </div>
              {/* Breakout expansion: the trigger keeps its half-width cell, but
                  the open drawer is its OWN grid row spanning BOTH columns — the
                  chip grid needs the full form width on desktop (the author). On
                  mobile the grid is single-column, so this is a no-op. */}
              {locOpen && (
                <div className="sm:col-span-2 rounded-md border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 p-2 max-h-72 overflow-y-auto">
                  <LocationChipPicker
                    value={locationId || null}
                    onChange={(v) => {
                      setLocTouched(true);
                      setLocationId(v ?? "");
                      persistLocation.mutate(v);
                      if (v) setLocOpen(false); // dropdown closes on a pick
                    }}
                  />
                </div>
              )}
            </>
          );
        })()}
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
          {willInstall ? <Download size={14} /> : <CheckCircle size={14} />}
          {confirmMut.isPending
            ? willInstall
              ? `Installing ${entry.label}…`
              : "Creating…"
            : willInstall
              ? `Install ${entry.label} & add`
              : "Confirm"}
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
