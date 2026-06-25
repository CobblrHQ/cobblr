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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  CheckCircle,
  ChevronDown,
  ExternalLink,
  FileText,
  Flag,
  Loader2,
  MapPin,
  MonitorSmartphone,
  RotateCcw,
  ScanLine,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { Modal, useImageSrc, useToast, usePageTitle } from "@cobblr/platform-web";
import { LocationPicker } from "../components/LocationPicker";
import { ImageSearchPicker } from "../components/ImageSearchPicker";
import { decideLocationScan, filingLabel } from "../lib/scanFiling";
import {
  type AiStatus,
  ApiError,
  api,
  type Location,
  type ScanInboxItem,
  type ScanCandidate,
  type ScanMenuEntry,
} from "../lib/api";
import { matchParentType, readField } from "../lib/parent-type-match";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";
import { resolveSessionBatch, clearScanSession, readScanSession, isSessionFresh } from "../lib/scanSession";
import { tabBrowserId } from "../hooks/useBrowserDrive";
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

// ── scan-drives-screen (Phase 1) ─────────────────────────────────────────────
interface ScanDrive {
  /** Has this tab opted in as the driven screen? */
  on: boolean;
  /** True once the drive hub has actually claimed THIS tab (stream connected). */
  active: boolean;
  /** Toggle this tab as the driven screen (non-destructive to a Claude grant). */
  toggle: () => void;
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

/** "Today" / "Yesterday" / "Jun 21" — the DAY header for loose (un-batched) scans
 *  grouped by calendar day. */
function formatDay(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "Earlier";
  const d = new Date(ms);
  const now = new Date();
  const sameDate = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDate(d, now)) return "Today";
  if (sameDate(d, yest)) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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

// ── "looks like the same product" clustering — for the combine offer ──
const COMBINE_STOP = new Set([
  "the", "and", "for", "with", "ultra", "soft", "pack", "count", "new", "size", "per", "each",
]);
function nameTokens(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !COMBINE_STOP.has(w)),
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
/** Cluster pending items that look like the SAME product so we can OFFER to
 *  combine them (you scanned 4 of one thing but a pack carried a different
 *  barcode). Anchored on the BRAND plus the shared PRODUCT words (brand words
 *  removed): two items cluster when, same brand, they share ≥2 significant
 *  non-brand tokens — or a high token ratio. A pure Jaccard bar was too strict:
 *  "Charmin … Toilet Paper … Jumbo Roll" vs "Charmin … Bath Tissue Jumbo Roll"
 *  are the same product but only share charmin/jumbo/roll, so this anchors on
 *  the 2 shared product words instead. Compared to each cluster's SEED so it
 *  can't drift. Always an opt-in offer, so erring slightly eager is fine. */
function productTokens(name: string | null | undefined, brand: string): Set<string> {
  const brandToks = nameTokens(brand);
  return new Set([...nameTokens(name)].filter((w) => !brandToks.has(w)));
}
function findCombineClusters(items: ScanInboxItem[]): ScanInboxItem[][] {
  const clusters: { brand: string; seed: Set<string>; items: ScanInboxItem[] }[] = [];
  for (const it of items) {
    const brand = (it.suggested_manufacturer ?? "").trim().toLowerCase();
    if (!brand || !it.suggested_name) continue;
    const product = productTokens(it.suggested_name, brand);
    if (product.size === 0) continue;
    const hit = clusters.find((c) => {
      if (c.brand !== brand) return false;
      let shared = 0;
      for (const w of product) if (c.seed.has(w)) shared++;
      return shared >= 2 || jaccard(c.seed, product) >= 0.5;
    });
    if (hit) hit.items.push(it);
    else clusters.push({ brand, seed: product, items: [it] });
  }
  return clusters.filter((c) => c.items.length >= 2).map((c) => c.items);
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

/** Local calendar-day key (YYYY-M-D in the viewer's timezone) — groups loose
 *  scans by the day they happened, not UTC (so a late-evening scan doesn't split
 *  across UTC midnight). */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function useScanDrive(slug: string | undefined, batchId: string | undefined): ScanDrive {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [on, setOn] = useState(false);
  const weRaisedGrant = useRef(false);
  const bid = useRef(tabBrowserId());

  // Remember the opt-in per workspace so a refresh keeps this as the scan screen.
  useEffect(() => {
    if (!slug) return;
    setOn(localStorage.getItem(`cobblr.scanDrive.${slug}`) === "1");
  }, [slug]);

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
      return api.scanDrive(slug!, code, sessionBatch);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      // The driven tab is navigated server-push via the DriveBanner stream. If
      // nothing is driven (single-device, no opt-in), do the friendly thing
      // locally so a QR scan on this very tab still opens the entity.
      if (!r.driven && r.kind === "qr" && r.path) navigate(r.path);
      if (r.kind === "qr") toast.success("Opened from QR");
      else toast.success(r.driven ? "Scanned → sent to your screen" : "Scanned → in the inbox");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return { on, active, toggle, scan: (code) => scanMut.mutate(code) };
}

/** The opt-in card: "this is my scan screen." */
function ScanDrivePanel({ drive }: { drive: ScanDrive }) {
  const active = drive.active;
  return (
    <div
      className={
        "flex items-center gap-3 rounded-md border px-3 py-2 text-sm transition " +
        (drive.on
          ? "border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30"
          : "border-line dark:border-slate-700")
      }
    >
      <MonitorSmartphone
        size={18}
        className={(drive.on ? "text-accent" : "text-faint") + " shrink-0"}
      />
      <div className="min-w-0 flex-1">
        <div className="text-content dark:text-mortar-100">
          {drive.on ? "This screen follows your scans" : "Drive this screen with scans"}
        </div>
        <div className="text-xs text-muted dark:text-slate-400">
          {drive.on
            ? active
              ? "Scan a bin or item from anywhere — it jumps to it here."
              : "Connecting this screen…"
            : "Make this the screen a wireless scan jumps to — a bin opens that bin, an item opens its intake."}
        </div>
      </div>
      {drive.on && (
        <span
          className={
            "shrink-0 rounded-full px-2 py-0.5 text-xs " +
            (active
              ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300"
              : "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300")
          }
        >
          {active ? "live" : "…"}
        </span>
      )}
      <button
        type="button"
        onClick={drive.toggle}
        className={
          "shrink-0 rounded border px-2.5 py-1 text-sm transition " +
          (drive.on
            ? "border-line dark:border-slate-700 text-content hover:bg-subtle dark:hover:bg-slate-800/70"
            : "border-cobble-600 bg-cobble-600 text-white hover:bg-cobble-700")
        }
      >
        {drive.on ? "Stop" : "Use this screen"}
      </button>
    </div>
  );
}

/** Selection key for a menu entry. */
function entryKey(module: string, instance: string | null): string {
  return `${module}::${instance ?? ""}`;
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

/** A colour VALUE → a CSS colour usable as a swatch background, or null if it
 *  isn't a colour we can render. A `#rrggbb` (or `rrggbb`) is used as-is; a NAME
 *  ("Royal Blue") is normalised to a CSS named colour ("royalblue") — vendors
 *  like Polar give us only the name, no hex (pfil.us returns `color:"Royal
 *  Blue"`), so this is the only way to show a swatch. Maker-specific names that
 *  aren't CSS colours ("Galaxy Black") return null → the caller shows text. */
function colorSwatch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  if (/^#?[0-9a-fA-F]{6}$/.test(v)) return v[0] === "#" ? v : `#${v}`;
  const named = v.toLowerCase().replace(/\s+/g, "");
  return typeof CSS !== "undefined" && CSS.supports?.("color", named) ? named : null;
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
  const [params] = useSearchParams();
  // Active filing "bin" — a core-locations node every scan files into until
  // cleared (the companion app activeBin pattern). Stamped as target_location_id on each
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
  const [urlsOpen, setUrlsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const receiptRef = useRef<HTMLInputElement>(null);
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
    refetchInterval: 8_000,
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
    const meta = (it.suggested_metadata ?? {}) as { low_trust?: boolean; rate_limited?: boolean };
    return (
      !it.suggested_name ||
      !!meta.low_trust ||
      !!meta.rate_limited ||
      (it.ai_confidence != null && Number(it.ai_confidence) < 0.5)
    );
  };
  const [reviewOnly, setReviewOnly] = useState(false);
  const reviewCount = items.filter(needsReview).length;
  const visibleItems = reviewOnly ? items.filter(needsReview) : items;

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
    mutationFn: ({ ids, keepId }: { ids: string[]; keepId: string }) =>
      api.combineScanItems(activeSlug, ids, keepId),
    onSuccess: (fresh) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success(`Combined into one — ${fresh.suggested_name ?? "item"} ×${fresh.quantity}`);
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
              <span className="text-muted"> Which listing to keep? Merges to ×{totalQty}, keeps the scanned barcode.</span>
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
            {cluster.items.length} items look like the same product
          </span>
          <span className="text-muted"> — {keep.suggested_name}. Combine into one (×{totalQty})?</span>
        </div>
        <button
          type="button"
          disabled={combineMut.isPending}
          onClick={() => combineMut.mutate({ ids, keepId: keep.id })}
          className="shrink-0 rounded bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          Combine
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
    const groups = new Map<
      string,
      { key: string; isBatch: boolean; items: ScanInboxItem[]; latest: number; area: string | null }
    >();
    for (const it of visibleItems) {
      const t = Date.parse(it.created_at);
      const key = it.scan_batch_id ?? `day:${Number.isFinite(t) ? localDayKey(t) : "unknown"}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, isBatch: !!it.scan_batch_id, items: [], latest: 0, area: null };
        groups.set(key, g);
      }
      g.items.push(it);
      if (Number.isFinite(t) && t > g.latest) g.latest = t;
      if (!g.area && it.scan_area) g.area = it.scan_area;
    }
    return [...groups.values()].sort((a, b) => b.latest - a.latest);
  }, [batchId, visibleItems]);
  // Every group (session or day) carries a meaningful time header now, so show
  // them whenever we're grouping at all.
  const showSessionHeaders = !!sessionGroups && sessionGroups.length > 0;
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(new Set());
  const toggleSession = (key: string) =>
    setCollapsedSessions((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // The active scanning session (localStorage), for the "Scanning into…" chip.
  const activeSession = readScanSession(activeSlug ?? "");
  const sessionActive = isSessionFresh(activeSession);

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
    onSuccess: () => {
      toast.success("Restored.");
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["scan-inbox-discarded", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

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
    mutationFn: (code: string) =>
      api.scanBarcode(activeSlug, {
        barcode: code,
        source_kind: "barcode",
        scan_batch_id: batchId ?? undefined,
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
      const qr = /^https?:\/\/[^/]+\/qr\/([A-Za-z0-9_-]{16,})$/.exec(code);
      if (!qr) {
        wedgeScan.mutate(code);
        return;
      }
      // A scanned LOCATION label sets the active filing bin (and nests a container
      // under the current bin) instead of staging an item — the companion app scan-to-set
      // flow. Any other QR stages as a normal scan.
      const token = qr[1] ?? "";
      void (async () => {
        const resolved = await api.resolveQrToken(token);
        const locId = resolved?.entity_id;
        if (
          resolved?.entity_kind === "core-locations:location" &&
          locId &&
          (!resolved.org_slug || resolved.org_slug === activeSlug)
        ) {
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
      const n = r.confirmed.filter((c) => !c.error).length;
      toast.success(
        r.order_id
          ? `Purchase order created — ${n} item${n === 1 ? "" : "s"}${r.vendor ? ` from ${r.vendor}` : ""}`
          : `Confirmed ${n} item${n === 1 ? "" : "s"} (enable Purchases to group them into an order)`,
      );
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

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
  const bulkConfirm = async () => {
    setBulkBusy(true);
    const byId = new Map(items.map((i) => [i.id, i]));
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    for (const id of selected) {
      const it = byId.get(id);
      const cand = it?.suggested_candidates?.[0];
      // Only auto-confirm items with a confident table match AND a name; the rest
      // stay for a manual look (reported in the summary).
      if (!it || !cand || !it.suggested_name) {
        skipped++;
        continue;
      }
      try {
        await api.confirmScanItem(activeSlug, id, {
          target_module: cand.module,
          target_kind: cand.kind,
          instance: cand.instance ?? undefined,
          name: it.suggested_name,
          quantity: it.quantity ?? cand.quantity ?? undefined,
          extras: cand.fields,
        });
        ok++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    clearSelected();
    void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
    const parts = [`${ok} confirmed`];
    if (skipped) parts.push(`${skipped} need a manual look`);
    if (failed) parts.push(`${failed} failed`);
    toast.success(parts.join(" · "));
  };

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      {/* ── the ONE header row: identity + intake. Short word labels;
            compact paddings keep it one row on phones. ──────────────── */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center border-b border-line dark:border-slate-700 pb-2.5">
        {/* identity — title, count, review/session chips */}
        <div className="flex items-center gap-2 min-w-0">
        <h1 className="text-lg font-semibold text-content dark:text-mortar-100 shrink-0">
          Inbox
        </h1>
        <span className="text-sm text-muted dark:text-slate-400 shrink-0">
          {totalPending}
          <span className="hidden sm:inline"> pending</span>
        </span>
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
        </div>
      </div>

      {/* Active filing bin: every scan (wedge gun, UPC, camera) files into this
          core-locations node until cleared — pick it, or scan a location's QR.
          Stamped as target_location_id so each item lands pre-filed. */}
      {locsEnabled && (
        <div className="flex items-center gap-2 text-sm -mt-1.5">
          <span className="inline-flex items-center gap-1 text-muted dark:text-slate-400 shrink-0">
            <MapPin size={14} /> Filing into
          </span>
          <div className="min-w-0 flex-1 max-w-[18rem]">
            <LocationPicker
              value={fileBin || null}
              onChange={(v) => setFileBin(v ?? "")}
              label=""
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

      <AiOffNotice status={aiStatus} />

      {receiptAddress && (
        <div className="flex items-center gap-2 text-xs text-muted dark:text-slate-400">
          <FileText size={13} className="text-faint shrink-0" />
          <span className="shrink-0">Or email receipts to</span>
          <code className="truncate rounded bg-mortar-100 dark:bg-slate-800 px-1.5 py-0.5 text-content dark:text-mortar-100">
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

      {purchasesEnabled &&
        receiptGroups.map((g) => (
          <div
            key={g.groupId}
            className="flex items-center gap-2 rounded-md border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2 text-sm"
          >
            <FileText size={15} className="text-accent shrink-0" />
            <span className="text-content dark:text-mortar-100">
              Receipt{g.vendor ? ` from ${g.vendor}` : ""} — {g.count} item{g.count === 1 ? "" : "s"} pending
            </span>
            <div className="flex-1" />
            <button
              type="button"
              disabled={confirmGroup.isPending}
              onClick={() => confirmGroup.mutate(g.groupId)}
              className="inline-flex items-center rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1 text-sm transition disabled:opacity-50 shrink-0"
            >
              {confirmGroup.isPending ? "Creating…" : "Confirm as purchase order"}
            </button>
          </div>
        ))}

      {/* Bulk-triage toolbar — appears once anything is selected. Confirm routes
          each item to its own matchmaker top candidate; discard clears them out. */}
      {(selected.size > 0 || (visibleItems.length > 1 && allVisibleSelected)) && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2 text-sm">
          <span className="font-medium text-content dark:text-mortar-100">{selected.size} selected</span>
          <button
            type="button"
            onClick={() => setSelected(new Set(visibleItems.map((i) => i.id)))}
            className="text-xs text-accent hover:underline"
          >
            select all {visibleItems.length}
          </button>
          <span className="flex-1" />
          {hasLocations && (
            <button
              type="button"
              disabled={bulkBusy || selected.size === 0}
              onClick={() => setBulkLocOpen((o) => !o)}
              className="rounded border border-line dark:border-slate-700 text-sm px-3 py-1 text-content hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-50"
            >
              Set location
            </button>
          )}
          <button
            type="button"
            disabled={bulkBusy || selected.size === 0}
            onClick={() => void bulkConfirm()}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1 transition disabled:opacity-50"
          >
            {bulkBusy ? "Working…" : "Confirm"}
          </button>
          <button
            type="button"
            disabled={bulkBusy || selected.size === 0}
            onClick={() => void bulkDiscard()}
            className="rounded border border-line dark:border-slate-700 text-sm px-3 py-1 text-bad hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-50"
          >
            Discard
          </button>
          <button type="button" onClick={clearSelected} className="text-xs text-faint hover:text-content">
            clear
          </button>
          {bulkLocOpen && (
            <div className="w-full pt-1">
              <LocationPicker
                value={null}
                onChange={(v) => v && void bulkApplyLocation(v)}
                label="File the selection into"
              />
            </div>
          )}
        </div>
      )}

      {sessionActive && !batchId && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-800/30 px-2.5 py-1.5 text-xs text-muted">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span>Scanning into the current session — scans group together until 30 min idle.</span>
          <button
            type="button"
            onClick={() => {
              clearScanSession(activeSlug);
              toast.success("Next scan starts a new session");
            }}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
          >
            New session
          </button>
        </div>
      )}

      <div className="space-y-2">
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
        {(() => {
          // Each card, with the combine offer injected just above the first item
          // of any cluster it belongs to (so the offer sits with its items).
          const card = (item: ScanInboxItem) => {
            const cluster = clusterByFirstId.get(item.id);
            return (
              <Fragment key={item.id}>
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
              </Fragment>
            );
          };
          // Flat list when there's nothing to group by (scoped ?batch view).
          if (!showSessionHeaders || !sessionGroups) return visibleItems.map(card);
          // Otherwise a collapsible header per group: a real session shows its
          // time (· area); a day bucket shows the day. Both show a count.
          return sessionGroups.map((g) => {
            const collapsed = collapsedSessions.has(g.key);
            return (
              <div key={g.key} className="space-y-2">
                <button
                  type="button"
                  onClick={() => toggleSession(g.key)}
                  className="flex w-full items-center gap-2 rounded-md bg-mortar-50 dark:bg-slate-800/40 px-2.5 py-1.5 text-left text-xs"
                >
                  <ChevronDown size={13} className={`shrink-0 transition ${collapsed ? "-rotate-90" : ""}`} />
                  <span className="font-medium text-content dark:text-mortar-100">
                    {g.isBatch ? formatSessionTime(g.latest) : formatDay(g.latest)}
                  </span>
                  {g.area && <span className="text-muted truncate">· {g.area}</span>}
                  <span className="ml-auto shrink-0 text-faint">
                    {g.items.length} item{g.items.length === 1 ? "" : "s"}
                  </span>
                </button>
                {!collapsed && <div className="space-y-2">{g.items.map(card)}</div>}
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
      </div>

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

      {upcOpen && <UpcModal onClose={() => setUpcOpen(false)} />}
      {urlsOpen && <UrlsModal onClose={() => setUrlsOpen(false)} />}
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
}: {
  item: ScanInboxItem;
  pageTarget: ScanTarget | null;
  menu: ScanMenuEntry[] | null;
  hasLocations: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  rateLimitGaveUp?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();

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

  // The matchmaker is SERVER-OWNED: it runs once at intake (detached) and
  // inline during a rerun. The web never auto-triggers it — a page load
  // costs zero model runs. While the server hasn't stamped matched_at yet,
  // the card shows a passive "AI is reading…" pulse that the 8s list poll
  // resolves on its own.
  const candidates = (item.suggested_candidates ?? []).slice(0, 3);
  const topCand = candidates[0] ?? null;
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
  const rerun = useMutation({
    mutationFn: (vars?: { hint?: string; wrong?: boolean; enrich?: boolean }) =>
      api.rerunScanAi(activeSlug, item.id, vars?.hint, vars?.wrong, vars?.enrich),
    onMutate: () => {
      if (isPhotoItem) {
        readingSnapshot.current = item.ai_suggested_at ?? null;
        setReading(true);
      }
    },
    onSuccess: (fresh, vars) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
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
  const rerunning = rerun.isPending || reading;
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
  const thumb = catalogImg ?? yoursImg;

  // Image viewer: click to zoom (lightbox), revert the catalog image to the
  // original (preserved server-side on the first override), or use your own scan
  // photo as the catalog image.
  const [zoom, setZoom] = useState<string | null>(null);
  const hasOrigCatalog = !!(item.suggested_metadata as { orig_catalog?: unknown } | null)?.orig_catalog;
  const catalogAction = useMutation({
    mutationFn: (action: "revert" | "use_own_photo") => api.scanCatalogAction(activeSlug, item.id, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const ddg = (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      {/* ── collapsed header row (click = expand) ───────────────────── */}
      <div
        className="p-3 flex items-start gap-3 cursor-pointer"
        onClick={() => (expanded ? setExpanded(false) : openForm())}
      >
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={!!selected}
            onClick={(e) => e.stopPropagation()}
            onChange={onToggleSelect}
            aria-label="Select for bulk action"
            className="mt-5 shrink-0 h-4 w-4 accent-cobble-600 cursor-pointer"
          />
        )}
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
          <div className="font-medium text-content dark:text-mortar-100 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            {item.suggested_name ? (
              <>
                <span className="truncate min-w-0 max-w-full">{item.suggested_name}</span>
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
            {item.barcode_text}
            {(item.suggested_metadata as { barcode_source?: string } | null)?.barcode_source === "ai-photo" && (
              <span className="text-amber-600 dark:text-amber-500"> (read from photo)</span>
            )}
            {item.suggested_manufacturer && ` · ${item.suggested_manufacturer}`}
            {item.suggested_sku && ` · ${item.suggested_sku}`}
            {item.scan_area && ` · 📍${item.scan_area}`}
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
          {/* Matchmaker chips — the best-fitting tables, their fields pre-filled.
              On phones only the TOP match shows (it's what Confirm uses) + a "+N"
              that expands to choose another; desktop shows them all. Keeps the
              collapsed card from being a wall of stacked pills on mobile. */}
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
                  className={`max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition border ${
                    i === 0 ? "inline-flex" : "hidden sm:inline-flex"
                  } ${
                    i === 0
                      ? "bg-cobble-600 hover:bg-cobble-700 text-white border-cobble-600"
                      : "bg-subtle dark:bg-slate-800 hover:bg-line dark:hover:bg-slate-700 text-content dark:text-mortar-200 border-line dark:border-slate-700"
                  }`}
                >
                  <Sparkles size={11} className="shrink-0" />
                  <span className="truncate">{c.label}</span>
                  {Object.keys(c.fields).length > 0 && (
                    <span className="opacity-70 shrink-0 hidden sm:inline">
                      · {Object.keys(c.fields).length} fields
                    </span>
                  )}
                </button>
              ))}
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
            onClick={() => discard.mutate()}
            disabled={discard.isPending}
            className="text-faint hover:text-ember-500 p-1.5 disabled:opacity-30"
            title="Discard (recoverable from Recently deleted)"
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
                  <button
                    type="button"
                    onClick={() => setZoom(catalogImg)}
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
                    onClick={() => setZoom(yoursImg)}
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
          {/* Image tools: revert to the original catalog photo, or use your own. */}
          {(hasOrigCatalog || (yoursImg && yoursImg !== catalogImg)) && (
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
            </div>
          )}
          {zoom &&
            createPortal(
              <div
                className="fixed inset-0 z-[100] bg-black/85 flex flex-col items-center justify-center gap-3 p-4 cursor-zoom-out"
                onClick={() => setZoom(null)}
                role="dialog"
                aria-label="Image viewer"
              >
                <img src={zoom} alt="" className="max-w-full min-h-0 flex-1 object-contain rounded shadow-2xl" />
                {/* Swap the photo without leaving the viewer (companion app). stopPropagation
                    so a thumbnail click doesn't also dismiss the lightbox. */}
                <div className="w-full max-w-2xl shrink-0" onClick={(e) => e.stopPropagation()}>
                  <PhotoOptions item={item} onPick={(u) => setZoom(u)} />
                </div>
              </div>,
              document.body,
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
              {/* Per-item history — what you did to this listing, newest first.
                  ("You asked for more detail · 2 min ago".) */}
              {(() => {
                const hist = (
                  item.suggested_metadata as { history?: { action: string; at: string; note?: string }[] } | null
                )?.history;
                if (!Array.isArray(hist) || hist.length === 0) return null;
                const label: Record<string, string> = {
                  rerun: "Re-ran the lookup",
                  wrong: "Flagged wrong — re-checked everything",
                  enrich: "Asked for more detail",
                  confirm: "Locked into the barcode database",
                  combine: "Combined similar items",
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
            hasBarcode={!!item.barcode_text}
            onConfirm={() => confirmBarcode.mutate()}
            confirming={confirmBarcode.isPending}
          />
          </div>
          </div>

          {/* The inline confirm form — full width below (the right-rail
              attempt collided labels at every width; reverted per the author). */}
          <ConfirmForm
            key={`${item.id}:${formCtx.selKey ?? "auto"}:${item.suggested_name ?? ""}:${item.suggested_manufacturer ?? ""}:${item.ai_suggested_at ?? ""}:${topCand ? topCand.label + JSON.stringify(topCand.fields) + (topCand.quantity ?? "") : "none"}`}
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
function PhotoOptions({ item, onPick }: { item: ScanInboxItem; onPick?: (url: string) => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const options = useQuery({
    queryKey: ["scan-photo-options", activeSlug, item.id],
    queryFn: () => api.scanPhotoOptions(activeSlug, item.id),
    // Only when there's a REAL name to search by — an unidentified item ("Unknown
    // Item") or a bare barcode returns junk photos, so don't even ask.
    enabled: !isUnidentified(item.suggested_name),
    staleTime: 5 * 60_000,
  });
  const pick = useMutation({
    mutationFn: (url: string) => api.setScanCatalogImage(activeSlug, item.id, url),
    onSuccess: (_data, url) => {
      toast.success("Catalog photo updated");
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      onPick?.(url); // swap the enlarged image in the lightbox to the picked one
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Drop options whose thumbnail won't load (dead hotlink / 404) — onError adds
  // the url here and we filter it out, so the strip never shows a broken tile.
  // The grid + broken-thumb handling live in the shared ImageSearchPicker; here
  // we keep the scan-item query/ranking (scanPhotoOptions) and the catalog apply.
  return (
    <ImageSearchPicker
      items={options.data?.items ?? []}
      loading={options.isLoading}
      busy={pick.isPending}
      onPick={(url) => pick.mutate(url)}
      label="other photo options"
    />
  );
}

// ── research hint: tell the AI what it got wrong, re-run with it ─────
function HintBox({
  onSubmit,
  busy,
  hasBarcode,
  onConfirm,
  confirming,
}: {
  onSubmit: (hint: string, opts: { wrong?: boolean; enrich?: boolean }) => void;
  busy: boolean;
  hasBarcode: boolean;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const [hint, setHint] = useState("");
  const fire = (opts: { wrong?: boolean; enrich?: boolean }) => {
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
          Enter submits, Shift+Enter inserts a newline — matches companion app. */}
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
      <div className="mt-1.5 flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50 shrink-0 inline-flex items-center gap-1.5"
        >
          <RotateCcw size={13} className={busy ? "animate-spin" : ""} /> {hint.trim() ? "Re-run with hint" : "Re-run AI"}
        </button>
      </div>
      {/* Triage, in traffic-light order — red → yellow → green:
          • This is wrong — distrust the identity entirely, re-derive from scratch.
          • Right — needs detail — product's right but the listing is thin; keep
            the identity, dig every source + the web for the full name/spec/photo.
          • This is good — verify the current listing into the shared barcode DB.
          The two corrections share a half-width row; the affirmative sits below. */}
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

        {/* "From the label" — everything the resolver parsed that ISN'T a
            field on this table (so the user sees the info was captured even
            though there's no box for it here — e.g. a spool's material/colour/
            temps, which ride onto its linked filament TYPE via the auto-lift).
            The covered keys (size, batch code…) already show filled in below. */}
        {(() => {
          const parsed = parsedScanFields(item.suggested_metadata as Record<string, unknown> | null);
          const covered = new Set(entry.fields.map((f) => f.name));
          const extra = Object.entries(parsed).filter(
            ([k, v]) => v != null && v !== "" && !covered.has(k),
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
