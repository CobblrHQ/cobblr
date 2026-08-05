// /scan/camera — full-screen immersive scanner, production-grade.
//
// The SHELL is a body-portaled `fixed inset-0` overlay: one tap on the
// header camera icon lands here and the stream AUTO-STARTS on mount —
// no "Start camera" button, no inbox detour. The camera fills the
// viewport; chrome (torch / area chip / status / close, reticle, the
// Assign·shutter·Done bar, manual UPC) floats over the video. Portaled
// to <body> because the app header's backdrop-blur traps position:fixed
// descendants; z-40 sits over the header (z-30) while ScanResultModal
// and the assign sheet (both z-50 Modals) still stack above.
//
// ONE screen, BOTH intake paths (the combination):
//   · a barcode in view auto-detects → blocks into the result modal;
//   · the big SHUTTER photographs a no-barcode item — the frame uploads
//     through core-files, lands as a PHOTO inbox item, and the existing
//     vision-identify wire (core-scan.scan.received → identify-photo)
//     names it in the background. Fire-and-forget; scanning never stops.
// The "Assign" area chip stamps `scan_area` on everything saved this
// session (both paths), so triage knows where you were standing.
//
// Two things make the ENGINE feel fast on an iPhone (lib/barcodeScanner):
//   1. we lock to a *plain* wide rear lens (not the ultra-wide that can't
//      focus close, nor the virtual composite that switches mid-scan) and
//      apply continuous autofocus — so you don't move the phone in/out;
//   2. on a hit we BLOCK — stop reading, pop a result modal with the
//      instant catalog match + a quantity stepper + one-tap "add to a
//      table" — instead of silently re-scanning the same code forever.
//
// Native BarcodeDetector (Chromium / iOS 17+) drives the loop when present;
// ZXing (tuned, ~110ms cadence) is the fallback. Both run on the SAME
// lens-locked stream.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, ArrowRight, Camera, Check, Flashlight, Loader2, MapPin, Package, Plus, ScanLine, SkipForward, Undo2, X, Zap } from "lucide-react";
import { LiveSurfaceProvider, Modal, usePageTitle, useOverlayOpenFlag, useToast } from "@cobblr/platform-web";
import { qrTokenFromUrl } from "@cobblr/platform-contract/qr-token";
import { ApiError, api, type LiveSortEntry, type ScanInboxItem, type ScanResolveCandidate, type TrackedMatch } from "../lib/api";
import { LOCATION_ENTITY_KIND, decideLocationScan, filingLabel } from "../lib/scanFiling";
import { freshDedupState, shouldFireScan, pickDetection, makeDetectionCollector, isGenericLink, type DedupState } from "../lib/scanDedup";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { LocationChipPicker } from "../components/LocationChipPicker";
import {
  SCAN_ATTEMPT_DELAY_MS,
  numericOverride,
  decodeCanvasSmart,
  NATIVE_FORMATS,
  acquireScannerStream,
  cameraHasTorch,
  captureFrame,
  createBarcodeReader,
  setTorch,
} from "../lib/barcodeScanner";
import { armScanAudio, scanBeep } from "../lib/scanFeedback";
import {
  sampleVideoLuma,
  torchAutoInitial,
  torchAutoRelease,
  torchAutoSample,
} from "../lib/torchAuto";
import { frameClockInitial, noteFrame, noteResume, shouldReacquire } from "../lib/videoLiveness";
import { zoomInitial, zoomPlan, zoomRange } from "../lib/scanZoom";
import { ScanResultModal } from "./ScanResultModal";
import { ScanCaptureDrawer } from "./ScanCaptureDrawer";
import { ScanDiagPanel } from "./ScanDiagPanel";
import { recordDecode, recordOrientation, recordStreamRecovery, recordTorchEvent, recordTorchSample, recordZoom, scanDiagEnabled } from "../lib/scanDiag";
import { BinAdjustModal } from "../components/BinAdjustModal";
import { ScanAmbiguityModal } from "../components/ScanAmbiguityModal";

// BarcodeDetector type — not in lib.dom.d.ts as of TS 5.7. Local shim.
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): {
    detect: (source: HTMLVideoElement | ImageBitmap | HTMLCanvasElement) => Promise<
      Array<{ rawValue: string; format?: string }>
    >;
  };
  getSupportedFormats(): Promise<string[]>;
}

// "resolving" = a QR label is being resolved server-side (or its modal is up):
// decoding pauses and the preview freezes, but the STREAM stays live — same
// trick as "result". "idle" (stream torn down) is only permission-denied /
// camera-error; routing a bin label through it re-acquired the lens on every
// scan (preview flicker, iOS black-stream failures, torch reset).
type Phase = "idle" | "scanning" | "resolving" | "result";

// Where a floating note (photo-saved, reading-label, resume) sits so it clears
// the top chrome on a notched phone. One constant, three overlays — they each
// carried their own copy of this magic number, so any change to the chrome's
// height had to be remembered in three places.
const UNDER_TOP_CHROME = "max(4.5rem, calc(env(safe-area-inset-top) + 3.5rem))";

// How long a code must be ABSENT from the frame before it counts as a new scan.
// The detect loop fires every animation frame, so a code held in view produces
// sightings tens of ms apart — far below this — and reads as one continuous scan.
// A deliberate re-scan means moving the code out of frame for about this long.
const REPEAT_GAP_MS = 1300;
// A GENERIC web link (a product's marketing QR, not a Cobblr label) is held this
// long before it fires, so a real product barcode beside it — a shoebox's UPC
// next to its qr.nike.com code — gets a chance to be read and win. A non-link
// code seen during the hold fires immediately and cancels it (the author, 2026-07-24).
const LINK_HOLD_MS = 700;

// Scan-session persistence — localStorage (NOT sessionStorage: phones kill
// background tabs, and resuming the same shelf-walk is the whole point).
interface ScanSession {
  batchId: string | null;
  areaId: string | null;
  count: number;
  at: number;
}
const sessionKey = (slug: string) => `cobblr.scan-session.${slug}`;
function readScanSession(slug: string): ScanSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(slug));
    return raw ? (JSON.parse(raw) as ScanSession) : null;
  } catch {
    return null;
  }
}
function writeScanSession(slug: string, s: ScanSession) {
  try {
    localStorage.setItem(sessionKey(slug), JSON.stringify(s));
  } catch {
    // Storage full / private mode — resume just won't be offered.
  }
}

export function ScanCameraPage() {
  usePageTitle("Scan");
  // This page IS an overlay — a body-portaled fixed inset-0 surface over the
  // whole app — so it raises the same flag every Modal and SidePanel raises.
  // Without it, floating chrome that yields to overlays (the Live pill, Quick
  // access, the feedback bubble) had no idea the scanner was up and floated
  // over the viewfinder (the author: "it def does not belong anywhere in the camera
  // scanner").
  useOverlayOpenFlag();
  // Preserve the instance-scan target (?into=…) so the modal + return keep it.
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const backToScan = `/scan${params.toString() ? `?${params}` : ""}`;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const detectorRef = useRef<InstanceType<BarcodeDetectorCtor> | null>(null);
  // Scanner dedup state (agreement gate + continuous-presence). The yes/no logic
  // is a pure, tested reducer (lib/scanDedup); this ref is just where its mutable
  // state lives across frames.
  const dedupRef = useRef<DedupState>(freshDedupState());
  // Deferral state for a generic web link (see LINK_HOLD_MS): the link value +
  // when its hold started. Cleared the moment a non-link code is seen.
  const linkHoldRef = useRef<{ value: string; heldAt: number } | null>(null);
  // phaseRef mirrors `phase` so the decode callbacks (set up once) read the
  // live value — once we're in the result modal, decodes are ignored. That
  // guard IS the "stop scanning the same thing over and over" fix.
  const phaseRef = useRef<Phase>("scanning");
  // Scan-serials-into-a-model: ?unitOf=<modelId> means each decoded code is a
  // SERIAL of that model, minted as a unit and the camera stays live for the
  // next — the dealership scanning 40 VINs into a lot. A ref so onDetect's deps
  // don't churn. See docs/design-decisions/within-instance-units.md.
  const unitOfRef = useRef<string | null>(params.get("unitOf"));
  useEffect(() => { unitOfRef.current = params.get("unitOf"); }, [params]);

  // Auto-start: mount straight into "scanning" so the lens turns on with no
  // extra tap. "idle" is now only the permission-denied / camera-error state.
  const [phase, setPhaseState] = useState<Phase>("scanning");
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const filingNoteTimerRef = useRef<number | null>(null);
  const showFilingNote = useCallback((text: string) => {
    setFilingNote(text);
    if (filingNoteTimerRef.current) window.clearTimeout(filingNoteTimerRef.current);
    filingNoteTimerRef.current = window.setTimeout(() => setFilingNote(null), 2200);
  }, []);

  // ?diag=1 — measure this device instead of guessing at it (bug-queue 3/4/5).
  const [diagOpen, setDiagOpen] = useState(scanDiagEnabled);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [pendingBarcode, setPendingBarcode] = useState<string | null>(null);
  // While armed for ＋Photo/Retake the scanner must not auto-detect: the label
  // you're photographing usually HAS a barcode on it, and a detection would
  // create a separate item mid-append (the orphan case).
  const armedRef = useRef(false);
  const diagRef = useRef(false);
  const zxingMarkRef = useRef<number | null>(null);
  // The viewfinder frame captured at the instant of the last barcode hit.
  // A PROMISE: canvas.toBlob is async, and the result modal fires its scan
  // within milliseconds of the hit — reading a plain ref lost the race and
  // items landed photo-less. The modal awaits this instead.
  const frameBlobRef = useRef<Promise<Blob | null> | null>(null);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  // Auto-flash: "you're trying to scan and it's dark, so let me help." The
  // top-left button is the MODE switch (auto on/off, default on); the small
  // button by the shutter is the manual override. All the strobe-avoidance
  // lives in the pure torchAuto machine; this page only applies its intents
  // and turns the torch off on lifecycle events (sheet up, close).
  const [autoTorch, setAutoTorch] = useState(true);
  const autoTorchRef = useRef(true);
  const torchAutoRef = useRef(torchAutoInitial());
  /** Who lit the torch. Lifecycle offs only touch "auto"; a manual torch
   *  stays lit until the user (or the stream dying) says otherwise. */
  const torchOwnerRef = useRef<"auto" | "manual" | null>(null);
  /** The user turned an auto-lit torch OFF by hand — don't fight them again
   *  this session (flipping the mode switch clears it). */
  const autoSuppressedRef = useRef(false);
  const hasTorchRef = useRef(false);
  const lumaCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastLumaAtRef = useRef(0);
  const prevLumaFrameRef = useRef<Uint8ClampedArray | null>(null);
  /** The estimator's verdict from the LAST decode attempt — the "was there
   *  anything code-like" evidence the fruitless-burn rule feeds on. */
  const lastStructureRef = useRef<boolean | undefined>(undefined);
  // Frame-liveness watchdog. iOS hands back a track that CLAIMS live+unmuted
  // after backgrounding while delivering no frames, so every track-state
  // check passes on a dead stream and the old recovery never fired (the
  // long-standing frozen-viewfinder-after-app-switch bug). The only honest
  // signal is frames actually rendering — requestVideoFrameCallback feeds
  // this clock, the decode loops ask it, and a stall bumps streamEpoch.
  const frameClockRef = useRef(frameClockInitial(Date.now()));
  const rvfcArmedRef = useRef(false);
  // Auto-zoom: the estimator locates the code on every missed frame, so "it is
  // too small to read" is a free measurement. A manual ?zoom=N turns this off —
  // an experiment you set by hand must not be steered from underneath.
  const zoomRef = useRef(zoomInitial());
  const zoomRangeRef = useRef<{ min: number; max: number } | null>(null);
  const autoZoomOffRef = useRef(false);

  // Scan area — stamped as `scan_area` (free text, the location's name) on
  // every item saved this session, barcode and photo alike. Picked via the
  // Assign sheet (LocationPicker over core-locations).
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [areaId, setAreaId] = useState<string | null>(null);
  // Scan-into-container: the active bin can be a container ENTITY (a server
  // asset, a machine) instead of a location. Mutually exclusive with areaId.
  const [containerBin, setContainerBin] = useState<{ kind: string; id: string } | null>(null);
  const containerBinRef = useRef<{ kind: string; id: string } | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  // Per-ITEM location override. Deliberately its own layer, not inline in the
  // sheet: a full picker can't fit in the height above the shutter, and the
  // session chip must keep meaning "where I'm standing" for the fast path.
  const [placingItem, setPlacingItem] = useState<ScanInboxItem | null>(null);
  const [shutterBusy, setShutterBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  // A shutter capture whose SAVE failed — the framed photo survives for a
  // retry tap instead of vanishing into an error toast (garage corners and
  // elevators drop POSTs; the item was already put back on the shelf).
  const [failedShot, setFailedShot] = useState<{
    blob: Blob;
    stamps: {
      areaName: string | null;
      areaId: string | null;
      container: { kind: string; id: string } | null;
    };
  } | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  // ＋Photo: the next shutter press APPENDS to this item instead of creating a
  // new one (the label shot then the display shot, on one record). Held in a
  // ref too because the shutter reads it from a callback.
  // THE ARM — "the next shutter press attaches to THIS item instead of making
  // a new one", which is what the paperclip on the shutter means. One state
  // with a mode, not a parallel useState per mode: a third one (catalog) as
  // its own flag would have meant three refs, three clears and three places to
  // forget. The mode only decides where the shot LANDS.
  //   append  — another shot on the record (the label, then the display shot)
  //   retake  — replace the shot the name came from, and read it again
  //   catalog — this shot becomes the item's display photo (the "nice photo",
  //             ADDED alongside the catalog art rather than replacing anything
  //             about the identification)
  type ArmMode = "append" | "retake" | "catalog";
  const [arm, setArm] = useState<{ id: string; name: string; mode: ArmMode } | null>(null);
  const armRef = useRef<{ id: string; name: string; mode: ArmMode } | null>(null);
  armRef.current = arm;
  armedRef.current = !!arm;
  diagRef.current = diagOpen;
  // An arm taken FROM a sheet must also surface the mini drawer: the armed
  // strip ("taking another photo…") lives there, and the sheet is about to
  // close without restoring it.
  const armFromSheet = (it: ScanInboxItem, mode: ArmMode) => {
    armFor(it, mode);
    setDrawerItem(it);
    setDrawerDismissed(false);
  };
  const armFor = useCallback(
    (it: ScanInboxItem, mode: ArmMode) =>
      setArm({
        id: it.id,
        name: it.suggested_candidates?.[0]?.name ?? it.suggested_name ?? "this item",
        mode,
      }),
    [],
  );
  // Dismissed = "I've dealt with this one, hide it". Cleared on the next save
  // so the drawer comes back for the next capture.
  const [drawerDismissed, setDrawerDismissed] = useState(false);
  const [drawerItem, setDrawerItem] = useState<ScanInboxItem | null>(null);
  // The drawer's full sheet is open: dim the viewfinder behind it and PAUSE
  // barcode detection — a code drifting into frame mid-edit would flip to the
  // result phase and unmount the sheet under the user's fingers. A ref twin
  // because the decode callbacks are bound once.
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetOpenRef = useRef(false);
  const handleSheetExpanded = useCallback((open: boolean) => {
    sheetOpenRef.current = open;
    setSheetOpen(open);
  }, []);
  // A barcode item being REVIEWED: the drawer's swipe-up reopens the same
  // "Scanned" sheet it was born in (ScanResultModal in existingItem mode)
  // instead of the photo sheet - one item, one sheet. Blocks detection and
  // dims the viewfinder exactly like an open drawer sheet.
  const [reviewItem, setReviewItem] = useState<ScanInboxItem | null>(null);
  const reviewItemRef = useRef<ScanInboxItem | null>(null);
  reviewItemRef.current = reviewItem;
  // The live Scanned sheet's row. The PAGE owns the barcode ingest (below) so
  // the sheet can close the instant an action is taken — an intent pressed
  // before the row lands is queued in earlyIntentRef and runs on arrival
  // (the author: "if I'm moving fast… I should be able to do that").
  const [resultItem, setResultItem] = useState<ScanInboxItem | null>(null);
  const [ingestBusy, setIngestBusy] = useState(false);
  const ingestKeyRef = useRef<string | null>(null);
  const earlyIntentRef = useRef<"discard" | "retake" | "photo" | null>(null);
  const resultItemRef = useRef<ScanInboxItem | null>(null);
  // Bumped to ask the drawer to collapse its expanded sheet (the + shutter
  // path for a photo item); the drawer owns the state, the page only asks.
  const [collapseNonce, setCollapseNonce] = useState(0);
  // A camera-LOCAL "photo saved" note (the author): the global toast landed at the
  // bottom and covered the shutter / UPC field, blocking rapid back-to-back
  // captures. This shows briefly at the TOP over the dark preview instead.
  // The last shutter frame as an object URL — the drawer's thumbnail, shown
  // the instant it's captured (before the upload finishes, offline included).
  // itemId is attached once the save lands so the drawer knows whose it is.
  const [lastFrame, setLastFrame] = useState<{ url: string; itemId: string | null } | null>(null);
  const setFrame = useCallback((blob: Blob) => {
    setLastFrame((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { url: URL.createObjectURL(blob), itemId: null };
    });
  }, []);
  useEffect(() => () => setLastFrame((prev) => { if (prev) URL.revokeObjectURL(prev.url); return null; }), []);
  // Filing feedback ("Filing into Guest Bedroom") shows HERE, at the top over the
  // dark preview — not through the global toast, which renders at the bottom and
  // sat directly on top of the shutter (the exact obstruction the author already
  // worked around for the photo-saved note). Same top slot, tap-through, auto-hide.
  const [filingNote, setFilingNote] = useState<string | null>(null);
  // Reading a QR label pauses the camera (the preview freezes) while we ask the
  // server what it points at. THAT is the moment worth narrating — the old
  // always-on "scanning" chip said "scanning" when the reticle already showed it
  // and went silent right here, so the freeze read as a hang.
  const [resolvingNote, setResolvingNote] = useState(false);
  // A scanned key that named several entities — the person picks, we never do.
  const [ambiguous, setAmbiguous] = useState<{
    key: string;
    candidates: ScanResolveCandidate[];
    truncated: boolean;
  } | null>(null);
  // Single-SKU bin (scanned its QR): direct qty-adjust modal for the one SKU
  // that lives there — the "bin of M3 screws" flow.
  const [binAdjust, setBinAdjust] = useState<{
    locationId: string;
    locationName: string;
    item: import("../lib/api").TrackedMatch;
  } | null>(null);
  // Move mode: scanning something already tracked (single exact
  // barcode match) auto-moves it into the active bin instead of triaging.
  const [moveMode, setMoveMode] = useState(() => localStorage.getItem("cobblr-scan-move-mode") === "1");
  const toggleMoveMode = useCallback(() => {
    setMoveMode((v) => {
      localStorage.setItem("cobblr-scan-move-mode", v ? "0" : "1");
      return !v;
    });
  }, []);
  // In-session MOVE HISTORY ("↶ Undo last N"): every auto/manual move
  // pushes here; each undo pops the most recent and re-files the entity where
  // it was — repeated taps walk back through the whole run. Only moves with a
  // known previous location are undoable (the endpoint needs a target).
  type MoveRec = { itemId: string; match: TrackedMatch; prevLocationId: string | null; title: string };
  const [moveStack, setMoveStack] = useState<MoveRec[]>([]);
  const undoableMoves = moveStack.filter((m) => m.prevLocationId);
  const undoMove = useMutation({
    mutationFn: (mv: MoveRec) =>
      api.scanAttach(activeSlug, mv.itemId, {
        kind: mv.match.kind,
        entity_id: mv.match.id,
        instance: mv.match.instance ?? undefined,
        mode: "move",
        location_id: mv.prevLocationId ?? undefined,
      }),
    onSuccess: (_r, mv) => {
      toast.success(`Moved ${mv.title} back`);
      setMoveStack((s) => s.filter((x) => x !== mv));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const locations = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });

  // Which QR'd kinds act as a CONTAINER bin ("scan into this")? Derived from the
  // entity-kind registry's declared traits — physical + unique (a server, a
  // machine, a tool chest), never a hardcoded module list. Locations are handled
  // by their own earlier branch; fungible kinds keep the normal scan behavior.
  const kindsQ = useQuery({
    queryKey: ["entity-kinds", activeSlug],
    queryFn: () => api.listEntityKinds(activeSlug),
    enabled: !!activeSlug,
    staleTime: 300_000,
  });
  const containerKindsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const axis = (t: unknown): string | null => {
      if (t == null) return null;
      if (typeof t === "string") return t;
      const v = (t as { trait?: unknown }).trait;
      return typeof v === "string" ? v : null;
    };
    containerKindsRef.current = new Set(
      (kindsQ.data?.items ?? [])
        .filter(
          (k) =>
            k.id !== "core-locations:location" &&
            axis(k.traits?.tangibility) === "physical" &&
            axis(k.traits?.identity) === "unique",
        )
        .map((k) => k.id),
    );
  }, [kindsQ.data]);

  // External QR resolver opt-in: only consult the redirect table on a scan if
  // the workspace actually has enabled rules — a workspace without rules pays no
  // round-trip and sees zero change. See docs/design-decisions/external-qr-resolver.md.
  const hasQrRulesRef = useRef(false);
  useEffect(() => {
    if (!activeSlug) return;
    let live = true;
    api
      .scanQrRules(activeSlug)
      .then((r) => {
        if (live) hasQrRulesRef.current = r.rules.some((rule) => rule.enabled);
      })
      .catch(() => {
        /* no rules / not reachable → resolver stays off */
      });
    return () => {
      live = false;
    };
  }, [activeSlug]);
  const areaName = useMemo(() => {
    if (!areaId) return null;
    const loc = (locations.data?.items ?? []).find((l) => l.id === areaId);
    return loc ? (loc.short_name ?? loc.name) : null;
  }, [areaId, locations.data]);
  // Refs so the memoised detect callback reads live values without re-binding
  // (re-binding would restart the camera). Scan-to-set reads these.
  const areaIdRef = useRef(areaId);
  areaIdRef.current = areaId;
  const locsRef = useRef(locations.data?.items);
  locsRef.current = locations.data?.items;
  containerBinRef.current = containerBin; // keep the scan-callback ref live

  // Tap-to-arm from the floor plan: /scan/camera?bin=<location-id> opens the
  // camera with that location already the active filing bin — "I'm standing
  // at the workbench." One-shot: only when no bin is set yet, once the
  // locations list can name it.
  const binParam = params.get("bin");
  useEffect(() => {
    if (!binParam || areaIdRef.current) return;
    const b = locations.data?.items?.find((l) => l.id === binParam);
    if (b) {
      setAreaId(b.id);
      showFilingNote(`Filing into ${filingLabel(b)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binParam, locations.data]);
  // Name of the active container bin, for the chip.
  const containerName = useQuery({
    queryKey: ["container-bin-name", activeSlug, containerBin?.kind, containerBin?.id],
    queryFn: () => api.lookupEntity(activeSlug, containerBin!.kind, containerBin!.id),
    enabled: !!containerBin && !!activeSlug,
    staleTime: 60_000,
  }).data?.title;

  // ── Scan session: batch + resume ─────────────────────────────────────
  // Every save this session shares one scan_batch_id (minted lazily on the
  // FIRST save — no empty batch rows), so "Done" can open the inbox scoped
  // to exactly what you just walked around scanning. The session (batch +
  // area + count) persists in localStorage so a phone that killed the tab
  // mid-shelf can RESUME the same batch instead of fragmenting it.
  const batchIdRef = useRef<string | null>(null);
  const batchMintRef = useRef<Promise<string | null> | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [resumable, setResumable] = useState<ScanSession | null>(null);

  const persistSession = useCallback(
    (patch: Partial<ScanSession>) => {
      writeScanSession(activeSlug, {
        batchId: batchIdRef.current,
        areaId,
        count: savedCount,
        at: Date.now(),
        ...patch,
      });
    },
    [activeSlug, areaId, savedCount],
  );

  // Mint the batch once per session; single-flight so a barcode hit and a
  // shutter press racing each other still share one batch.
  const ensureBatchId = useCallback(async (): Promise<string | null> => {
    if (batchIdRef.current) return batchIdRef.current;
    if (!batchMintRef.current) {
      batchMintRef.current = api
        .createScanBatch(activeSlug)
        .then((b) => {
          batchIdRef.current = b.id;
          return b.id;
        })
        .catch(() => {
          // A failed mint never blocks the scan itself — just un-batched.
          batchMintRef.current = null;
          return null;
        });
    }
    return batchMintRef.current;
  }, [activeSlug]);

  // SORT MODE (Live Sort, phone rig — docs/product/put-away.md §3.1): scanning
  // a product barcode routes it to a destination directive ("→ Bin 1 ·
  // Fasteners") rendered as an overlay ON the live viewfinder — the camera
  // never unmounts, no result modal. One big "Done, next" confirms; a scanned
  // bin QR while a directive shows confirms INTO that bin (retarget).
  // ?sort=1 (the homepage "Start a Live Sort" link on touch devices) arms
  // Sort mode on arrival; the preference then persists like the manual toggle.
  const [sortMode, setSortMode] = useState(() => {
    if (new URLSearchParams(window.location.search).get("sort") === "1") {
      localStorage.setItem("cobblr-scan-sort-mode", "1");
      return true;
    }
    return localStorage.getItem("cobblr-scan-sort-mode") === "1";
  });
  // Consume-once: ?sort=1 armed Sort mode above (into state + localStorage), so
  // strip it from the URL. Otherwise it persisted and re-armed Sort mode on every
  // refresh, overriding the user later toggling it OFF (the same class of bug as
  // scan?organize=pending; the author, 2026-07-10).
  useEffect(() => {
    if (!params.has("sort")) return;
    const next = new URLSearchParams(params);
    next.delete("sort");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ?container_kind=&container_id= arms a SPECIFIC container as the active bin —
  // the "Scan items into this" deep-link from a container's Contents panel. Unlike
  // scanning a container's QR (gated to physical+unique kinds), an explicit link
  // arms any container the user chose, including a fungible-kind part used as a
  // one-off box (a "box of mugs"). Consume-once, like ?sort=1.
  useEffect(() => {
    const ck = params.get("container_kind");
    const ci = params.get("container_id");
    if (!ck || !ci) return;
    const cb = { kind: ck, id: ci };
    setContainerBin(cb);
    containerBinRef.current = cb;
    setAreaId(null);
    const next = new URLSearchParams(params);
    next.delete("container_kind");
    next.delete("container_id");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sortModeRef = useRef(sortMode);
  sortModeRef.current = sortMode;
  // Phase 3 experiment: scanning the NEXT item commits the previous directive
  // (undo chip still covers mistakes). Opt-in, persisted.
  const [sortImplicit, setSortImplicit] = useState(
    () => localStorage.getItem("cobblr-scan-sort-implicit") === "1",
  );
  const sortImplicitRef = useRef(sortImplicit);
  sortImplicitRef.current = sortImplicit;
  const toggleSortImplicit = useCallback(() => {
    setSortImplicit((v) => {
      localStorage.setItem("cobblr-scan-sort-implicit", v ? "0" : "1");
      return !v;
    });
  }, []);
  const [sortEntry, setSortEntry] = useState<LiveSortEntry | null>(null);
  const sortEntryRef = useRef<LiveSortEntry | null>(null);
  sortEntryRef.current = sortEntry;
  const [sortBusy, setSortBusy] = useState(false);
  const sortBusyRef = useRef(false);
  const [sortLast, setSortLast] = useState<LiveSortEntry | null>(null);
  const [sortCount, setSortCount] = useState(0);
  const sortSessionRef = useRef<string | null>(null);
  const sortRerouteTimer = useRef<number | null>(null);
  const toggleSortMode = useCallback(() => {
    setSortMode((v) => {
      localStorage.setItem("cobblr-scan-sort-mode", v ? "0" : "1");
      if (v) {
        // Toggling OFF pauses, never ends — the session resumes (here or on
        // the Scan page's Live Sort) and one summary covers the whole run.
        setSortEntry(null);
        setSortBusy(false);
        sortBusyRef.current = false;
      }
      return !v;
    });
  }, []);
  // Sort mode on → start/resume the caller's live put-away session.
  useEffect(() => {
    if (!sortMode) return;
    let cancelled = false;
    void api
      .startPutaway(activeSlug, {})
      .then((r) => {
        if (cancelled) return;
        sortSessionRef.current = r.session_id;
        const confirmed = (r.entries ?? []).filter((e) => e.status === "confirmed").length;
        setSortCount(confirmed);
        if (r.resumed && confirmed > 0) toast.info(`Sort session resumed — ${confirmed} sorted so far.`);
      })
      .catch(() => {
        toast.error("Couldn't start the sort session.");
        setSortMode(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortMode, activeSlug]);

  const routeSortItem = useCallback(
    async (inboxItemId: string) => {
      const sid = sortSessionRef.current;
      if (!sid) return;
      const r = await api.putawayScan(activeSlug, sid, { inbox_item_id: inboxItemId });
      if (r.already_placed) {
        toast.info(`Already lives in ${r.already_placed.location_name ?? "a bin"} — re-find, not a re-sort.`);
        return;
      }
      if (!r.entry) return;
      setSortEntry(r.entry);
      // A bare item often gets its name a beat later — one silent re-route
      // upgrades "Unsorted" into a real bin in place.
      if (!r.entry.name && r.entry.status === "proposed") {
        const itemId = r.entry.inbox_item_id;
        if (sortRerouteTimer.current) window.clearTimeout(sortRerouteTimer.current);
        sortRerouteTimer.current = window.setTimeout(() => {
          void api
            .putawayScan(activeSlug, sid, { inbox_item_id: itemId })
            .then((again) => {
              if (again.entry) {
                setSortEntry((cur) => (cur && cur.inbox_item_id === itemId ? again.entry! : cur));
              }
            })
            .catch(() => {});
        }, 2_500);
      }
    },
    [activeSlug, toast],
  );

  const handleSortScan = useCallback(
    (raw: string) => {
      if (sortBusyRef.current) return;
      const pending = sortEntryRef.current;
      if (pending) {
        if (sortImplicitRef.current && pending.status === "proposed") {
          // Implicit commit: the next scan IS the confirm gesture for the
          // previous directive (undo chip covers mistakes).
          confirmSortRef.current();
        } else {
          return; // one directive at a time
        }
      }
      sortBusyRef.current = true;
      setSortBusy(true);
      void (async () => {
        try {
          // The scan-moment frame rides along as the item's photo (best-effort).
          const blob = await (frameBlobRef.current ?? Promise.resolve(null)).catch(() => null);
          let imageFileId: string | undefined;
          if (blob) {
            const file = new File([blob], `sort-${Date.now()}.jpg`, { type: "image/jpeg" });
            imageFileId = await api
              .uploadFile(activeSlug, file)
              .then((rec) => rec.id)
              .catch(() => undefined);
          }
          const batchId = await ensureBatchId();
          // NOTE: no target_location_id — sort mode ROUTES; the active-bin
          // stamp would make every scan read as already-placed.
          const item = await api.scanBarcode(activeSlug, {
            barcode: raw,
            source_kind: "barcode",
            image_file_id: imageFileId,
            scan_area: areaName ?? undefined,
            scan_batch_id: batchId ?? undefined,
            enrich_ms: 3_000,
          });
          void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
          await routeSortItem(item.id);
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : String(e));
        } finally {
          sortBusyRef.current = false;
          setSortBusy(false);
        }
      })();
    },
    [activeSlug, areaName, ensureBatchId, qc, routeSortItem, toast],
  );

  const confirmSort = useCallback(
    (overrideLocationId?: string) => {
      const sid = sortSessionRef.current;
      const entry = sortEntryRef.current;
      if (!sid || !entry || entry.status !== "proposed") return;
      if (!overrideLocationId && !entry.directive.location_id) {
        toast.info("No bin suggested - scan the bin's QR label to file it there.");
        return;
      }
      void api
        .putawayConfirm(activeSlug, sid, {
          entry_id: entry.id,
          ...(overrideLocationId ? { location_id: overrideLocationId } : {}),
        })
        .then((r) => {
          if (typeof navigator.vibrate === "function") navigator.vibrate(40);
          scanBeep("confirm");
          setSortLast(r.entry);
          // Only clear if the banner still shows THIS entry — under implicit
          // commit the next scan's directive may already be up.
          setSortEntry((cur) => (cur && cur.id === r.entry.id ? null : cur));
          setSortCount((n) => n + 1);
        })
        .catch((e) => toast.error(e instanceof ApiError ? e.message : String(e)));
    },
    [activeSlug, toast],
  );
  const confirmSortRef = useRef(confirmSort);
  confirmSortRef.current = confirmSort;

  // ── what a resolved QR DOES ──────────────────────────────────────────────
  // One handler for every label that resolves to an entity in this workspace,
  // whether it was printed by Cobblr (/qr/<token>) or by another system the
  // workspace taught Cobblr to read (the external QR resolver). The ACTION is a
  // property of what the label points AT, never of who printed it:
  //
  //   location  → set the filing bin (keep scanning INTO it), never navigate
  //   container → set the container bin
  //   anything else → open its detail page
  //
  // Foreign labels used to skip all of this and navigate straight to
  // detail_path, so scanning a linked companion app room label opened the room's
  // page instead of pointing the scanner at that room.
  type ResolvedQr = {
    entity_kind: string;
    entity_id: string;
    org_slug?: string | undefined;
  };
  const routeResolved = useCallback(
    async (r: ResolvedQr | null, fallbackPath: string) => {
      const mine = !!r?.entity_id && (!r.org_slug || r.org_slug === activeSlug);
      const isLocation = mine && r!.entity_kind === LOCATION_ENTITY_KIND;

      // Sort mode with a directive on screen: a BIN label is the "put it there
      // instead" gesture. The camera never pauses for this.
      if (sortModeRef.current && sortEntryRef.current) {
        if (isLocation) confirmSortRef.current(r!.entity_id);
        else toast.error("That QR isn't a bin label.");
        return;
      }

      if (isLocation) {
        const locId = r!.entity_id;
        // Single-SKU bin? Then the bin's QR IS the item's label (loose M3 screws
        // carry no codes) — go straight to adjusting ITS count in THIS bin.
        // Multi-SKU / empty bins keep the filing flow below.
        try {
          const contents = await api.binContents(activeSlug, locId);
          if (contents.single && contents.items[0]) {
            const items0 = locsRef.current ?? [];
            const loc = items0.find((l) => l.id === locId);
            setBinAdjust({
              locationId: locId,
              locationName: loc ? filingLabel(loc) : "this bin",
              item: contents.items[0],
            });
            return; // stay in "resolving" — the modal owns the screen, the stream stays warm
          }
        } catch {
          /* contents unavailable → normal filing flow */
        }
        const items = locsRef.current ?? [];
        const byId = new Map(
          items.map((l) => [
            l.id,
            { id: l.id, name: l.name, short_name: l.short_name, parent_id: l.parent_id, kind: l.kind },
          ]),
        );
        const decision = decideLocationScan(locId, areaIdRef.current, byId);
        // Already filing here and nothing to reparent → a no-op. Re-announcing
        // "Filing into Guest Bedroom" when it's already the active bin is noise;
        // the continuous-presence dedup should stop the re-scan before this, but
        // this makes it correct even if a code briefly leaves and returns.
        if (!decision.reparent && decision.bin === areaIdRef.current) {
          setPhase("scanning");
          return;
        }
        if (decision.reparent) {
          try {
            await api.updateLocation(activeSlug, decision.reparent.child, {
              parent_id: decision.reparent.parent,
            });
            await locations.refetch();
          } catch {
            /* cycle / permission — fall back to a plain adopt */
          }
        }
        setAreaId(decision.bin);
        setContainerBin(null); // location + container bins are exclusive
        containerBinRef.current = null;
        const b = byId.get(decision.bin);
        const nm = b ? filingLabel(b) : "location";
        const p = decision.reparent ? byId.get(decision.reparent.parent) : null;
        showFilingNote(
          p ? `Filed ${nm} in ${filingLabel(p)} — filing into ${nm}` : `Filing into ${nm}`,
        );
        setPhase("scanning");
        return;
      }

      // A container-capable entity's QR (a machine, a server asset, any
      // physical+unique kind per its declared traits) becomes the active
      // CONTAINER bin — every barcode you scan then files INTO it (a
      // placement), like a location bin. Mutually exclusive with the location
      // bin. Kinds come from the registry, never a hardcoded list.
      if (mine && containerKindsRef.current.has(r!.entity_kind)) {
        const cb = { kind: r!.entity_kind, id: r!.entity_id };
        setContainerBin(cb);
        containerBinRef.current = cb;
        setAreaId(null);
        areaIdRef.current = null;
        showFilingNote("Filing into this — scan components to add them inside.");
        setPhase("scanning");
        return;
      }

      navigate(fallbackPath);
    },
    [activeSlug, locations, navigate, setPhase, toast],
  );
  const routeResolvedRef = useRef(routeResolved);
  routeResolvedRef.current = routeResolved;

  const undoSort = useCallback(() => {
    const sid = sortSessionRef.current;
    const last = sortLast;
    if (!sid || !last) return;
    void api
      .putawayUndo(activeSlug, sid, { entry_id: last.id })
      .then(() => {
        setSortLast(null);
        setSortCount((n) => Math.max(0, n - 1));
        toast.success("Undone - back to unsorted.");
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : String(e)));
  }, [activeSlug, sortLast, toast]);


  // Offer to resume a recent session (same workspace, < 4h old, has saves).
  useEffect(() => {
    const s = readScanSession(activeSlug);
    if (s?.batchId && s.count > 0 && Date.now() - s.at < 4 * 60 * 60 * 1000) {
      setResumable(s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlug]);
  const resume = useCallback(() => {
    if (!resumable) return;
    batchIdRef.current = resumable.batchId;
    setSavedCount(resumable.count);
    if (resumable.areaId) setAreaId(resumable.areaId);
    setResumable(null);
  }, [resumable]);

  // Keep the persisted session's area current once a session is real
  // (a batch exists or something was saved) — resume restores it.
  useEffect(() => {
    if (savedCount > 0 || batchIdRef.current) persistSession({ areaId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaId]);

  useEffect(() => {
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
      .BarcodeDetector;
    setSupported(!!Detector);
  }, []);

  // Close → back to wherever the scanner was opened from. A direct URL load
  // (location.key === "default") has no in-app history, so land on the scan
  // inbox instead of leaving the app.
  const close = useCallback(() => {
    if (location.key !== "default") navigate(-1);
    else navigate(backToScan);
  }, [location.key, navigate, backToScan]);

  // The overlay covers the page — stop the page behind it from scrolling.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Beep support: create the audio context now, unlock it on the first tap
  // (iOS requires a gesture), so scan blips are audible by the first hit.
  useEffect(() => armScanAudio(), []);

  // Escape closes the scanner (desktop nicety; the X is the touch path).
  // The result modal and the assign sheet own Escape while they're open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && phaseRef.current !== "result" && !assignOpen) close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, assignOpen]);

  // A decoded value → block into the result modal (dedup a stale repeat first).
  // EXCEPT Cobblr QR labels: a printed label encodes <host>/qr/<token>
  // (parsed by the shared qrTokenFromUrl — do NOT hand-roll a length here,
  // the token got shorter once already and the local copy went quietly dead),
  // and that's a
  // navigation, not a product — route it to the /qr resolver, which lands
  // on the labeled entity. Without this, scanning your own label staged a
  // junk "no catalog match" inbox item.
  //
  // Routed through a ref (onDetectRef) by the camera effect: onDetect's identity
  // flips whenever a toast mounts/unmounts (toast is in its deps), and the
  // camera effect stops+restarts the stream on any dep change — so a "Photo
  // saved" toast used to RESTART the camera (the flicker/reset the author saw). The
  // ref lets that effect depend only on `running`.
  const onDetectRef = useRef<(raw: string) => void>(() => {});
  const onDetect = useCallback(
    (rawIn: string) => {
      if (phaseRef.current !== "scanning") return;
      // Armed for ＋Photo / Retake: ignore codes entirely. You are pointing at a
      // label to photograph it, and that label usually carries a barcode - a
      // detection here would mint a separate item mid-append.
      if (armedRef.current) return;
      // The drawer's full sheet (or a barcode review sheet) is open: the user
      // is editing, not scanning.
      if (sheetOpenRef.current || reviewItemRef.current) return;
      const raw = rawIn.trim();
      if (!raw) return;
      // HOLD a generic web link (a product's marketing QR — NOT a Cobblr label,
      // those parse via qrTokenFromUrl and route to a bin/entity). pickDetection
      // already ranks a link below every barcode WITHIN a frame, but the native
      // iOS detector reads a 2D QR every frame while the 1D UPC lands only
      // intermittently, so the link cleared the 2-sighting gate before the barcode
      // was ever co-seen — it "grabbed the QR every time, ignoring the UPC" (the author,
      // 2026-07-24). Give the barcode a window: hold the link, and a non-link code
      // seen meanwhile fires and cancels the hold; only a link still alone after
      // LINK_HOLD_MS falls through to fire.
      if (isGenericLink(raw)) {
        const now = Date.now();
        const h = linkHoldRef.current;
        if (!h || h.value !== raw || now - h.heldAt > REPEAT_GAP_MS + LINK_HOLD_MS) {
          linkHoldRef.current = { value: raw, heldAt: now };
          return; // start of a fresh hold — wait for a barcode
        }
        if (now - h.heldAt < LINK_HOLD_MS) return; // still holding
        // grace elapsed and no barcode won → let the link through the gate below.
      } else {
        linkHoldRef.current = null; // a real code showed up: it wins, drop the hold
      }
      // Agreement gate + continuous-presence dedup, in one tested reducer. A code
      // held steady in the frame is ONE scan; it only re-fires after leaving the
      // frame and coming back. This is the fix for a location QR spamming a new
      // "Filing into…" toast every couple of seconds.
      if (!shouldFireScan(dedupRef.current, raw, Date.now(), REPEAT_GAP_MS)) return;
      if (typeof navigator.vibrate === "function") navigator.vibrate(70);
      scanBeep("scan");

      // ?unitOf: this code is a SERIAL, not an entity to identify. File it as a
      // unit of the target model and stay scanning — no result modal, no
      // identify pipeline. Everything below is untouched when unitOf is absent.
      if (unitOfRef.current) {
        const modelId = unitOfRef.current;
        void (async () => {
          try {
            const u = await api.mintScannedUnit(activeSlug, {
              modelId,
              instance: params.get("into"),
              serial: raw,
            });
            toast.success(`Filed ${u.serial_number ?? "a unit"}`);
          } catch (e) {
            // Name the code that failed — in a 40-serial run "that serial" is
            // unfindable; this one can be retyped into the manual field.
            toast.error(
              `Couldn't file ${raw}${e instanceof ApiError ? ` — ${e.message}` : " — scan it again."}`,
            );
          }
        })();
        return;
      }

      // Sort mode with a directive on screen keeps the camera LIVE while we
      // resolve — a bin label there is the retarget gesture, not a navigation.
      const sortRetarget = sortModeRef.current && !!sortEntryRef.current;

      // A native Cobblr label. What it points at decides what happens
      // (routeResolved); the token is only the fallback nav target.
      const qrToken = qrTokenFromUrl(raw);
      if (qrToken) {
        const token = qrToken;
        if (!sortRetarget) {
          setPhase("resolving"); // freeze decode + preview; the stream stays live
          setResolvingNote(true);
        }
        void (async () => {
          const resolved = await api.resolveQrToken(token).catch(() => null);
          setResolvingNote(false);
          await routeResolvedRef.current(
            resolved?.entity_kind && resolved.entity_id
              ? {
                  entity_kind: resolved.entity_kind,
                  entity_id: resolved.entity_id,
                  org_slug: resolved.org_slug,
                }
              : null,
            `/qr/${token}`,
          );
        })();
        return;
      }

      // Capture the frame AT the scan moment — it rides the inbox item as YOUR
      // photo next to the catalog image. Done HERE, past the Cobblr-QR path above:
      // a location / bin QR sets a filing target and makes NO inbox item, so it
      // has no use for a frame — and the synchronous full-res drawImage stutters
      // the live preview. Grabbing it only on the paths that keep it is what keeps
      // the camera smooth while you hold a location label. The video pauses on the
      // result modal, so this exact frame is also what stays on screen.
      const video = videoRef.current;
      if (video) frameBlobRef.current = captureFrame(video);

      // External QR resolver (the redirect table): a foreign label the workspace
      // has taught Cobblr to read resolves to a native entity and then behaves
      // EXACTLY like a native scan — same routeResolved, so a linked system's
      // room label sets the filing bin rather than opening the room.
      // Opt-in — only consulted when rules exist. A plain product barcode can't
      // be a foreign QR label, so it skips the round trip and Sort mode's hot
      // loop stays as fast as it was.
      // See docs/design-decisions/external-qr-resolver.md.
      const bareProductBarcode = /^\d{8,14}$/.test(raw);
      if (hasQrRulesRef.current && !bareProductBarcode) {
        if (!sortRetarget) {
          setPhase("resolving"); // freeze decode + preview; the stream stays live
          setResolvingNote(true);
        }
        void (async () => {
          try {
            const out = await api.scanResolveExternal(activeSlug, raw);
            setResolvingNote(false);
            if (out.outcome === "resolved") {
              await routeResolvedRef.current(
                { entity_kind: out.entity_kind, entity_id: out.entity_id },
                out.detail_path,
              );
              return;
            }
            if (out.outcome === "ambiguous") {
              // Several entities carry this key. Hold the camera frozen and ask
              // rather than opening one of them: picking here is exactly the bug
              // this outcome exists to remove.
              setAmbiguous({
                key: out.key,
                candidates: out.candidates,
                truncated: out.truncated,
              });
              return;
            }
            if (out.outcome === "recognized_no_match") {
              // The format is a known rule (intent declared) but nothing here
              // matches — a calm, specific note, NOT an error, and we do NOT fall
              // through to web search. Re-arm the camera.
              toast.info(
                `Recognized this as “${out.rule_name}” (${out.key}), but nothing here matches it yet.`,
              );
              setPhase("scanning");
              return;
            }
            // "no_rule" → not a resolver scan: the normal routine for this mode.
            if (sortModeRef.current) {
              setPhase("scanning");
              handleSortScan(raw);
              return;
            }
            setPendingBarcode(raw);
            setPhase("result");
          } catch {
            // A resolver hiccup must never swallow the scan — fall through.
            setResolvingNote(false);
            if (sortModeRef.current) {
              setPhase("scanning");
              handleSortScan(raw);
              return;
            }
            setPendingBarcode(raw);
            setPhase("result");
          }
        })();
        return;
      }

      // SORT MODE: a product barcode routes to a directive inline — the camera
      // never pauses and the result modal never opens.
      if (sortModeRef.current) {
        handleSortScan(raw);
        return;
      }
      setPendingBarcode(raw);
      setPhase("result");
    },
    [setPhase, activeSlug, handleSortScan, toast],
  );
  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  // Start / stop the camera. Acquire ONE lens-locked stream and keep it alive
  // for the whole session; the phase guard pauses/resumes decoding so re-arm
  // after a scan is instant and the lens never switches.
  const running = phase !== "idle";
  // Bumped when the tab returns from the background to a DEAD stream — phones
  // revoke the camera on lock/app-switch, and without this the preview came
  // back as a frozen black frame until the user left and re-entered the page.
  const [streamEpoch, setStreamEpoch] = useState(0);
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== "visible" || phaseRef.current === "idle") return;
      // Returning to the tab: no frames arrived while hidden, so the liveness
      // clock is stale by construction — grace-reset it and let the watchdog
      // judge the stream on what it delivers from HERE.
      frameClockRef.current = noteResume(frameClockRef.current, Date.now());
      const track = streamRef.current?.getVideoTracks()[0] ?? null;
      if (!track || track.readyState === "ended") {
        setStreamEpoch((e) => e + 1);
        return;
      }
      // iOS sometimes keeps the track but returns it muted; nudge playback,
      // give it a beat to self-resume, then re-acquire if it stays dark.
      void videoRef.current?.play().catch(() => {});
      window.setTimeout(() => {
        const t = streamRef.current?.getVideoTracks()[0] ?? null;
        if (
          document.visibilityState === "visible" &&
          t &&
          (t.muted || t.readyState === "ended")
        ) {
          setStreamEpoch((e) => e + 1);
        }
      }, 800);
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let raf: number | null = null;
    let zxingControls: { stop: () => void } | null = null;
    const useNative = !!(window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
      .BarcodeDetector;

    function afterStream(stream: MediaStream) {
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0] ?? null;
      hasTorchRef.current = cameraHasTorch(track);
      setHasTorch(hasTorchRef.current);
      zoomRangeRef.current = zoomRange(track);
      autoZoomOffRef.current = numericOverride("zoom", 0, 10) > 0;
      zoomRef.current = zoomInitial();
    }

    async function start() {
      try {
        const { stream, deviceId } = await acquireScannerStream(deviceIdRef.current);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        deviceIdRef.current = deviceId;
        afterStream(stream);

        if (useNative) {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            armFrameClock(videoRef.current);
            await videoRef.current.play();
            // Re-acquired mid-modal (visibility recovery): keep the preview
            // frozen — the freeze effect only reacts to phase CHANGES.
            if (phaseRef.current === "result" || phaseRef.current === "resolving") {
              videoRef.current.pause();
            }
          }
          const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
            .BarcodeDetector!;
          detectorRef.current = new Detector({ formats: NATIVE_FORMATS });
          loop();
        } else {
          // OUR OWN decode loop, not reader.decodeFromStream.
          //
          // ZXing's built-in loop retries rotated when TRY_HARDER is set, and
          // that retry is broken: HTMLCanvasElementLuminanceSource.rotate()
          // swaps the pixels but never updates its width/height, so the
          // rotated buffer is read with the original stride and can never
          // decode on a non-square frame. Perpendicular barcodes therefore
          // NEVER scanned, whatever the light or attempt rate (the author,
          // 2026-08-05). Owning the loop lets us rotate into our own correctly
          // sized canvas — and costs nothing else, since the loop is a few
          // lines and we already control cadence, pausing and instrumentation.
          const reader = createBarcodeReader();
          zxingMarkRef.current = null;
          const collect = makeDetectionCollector(400);
          const frame = document.createElement("canvas");
          const rotated = document.createElement("canvas");
          const video = videoRef.current!;
          video.srcObject = stream; // decodeFromStream used to do this for us
          armFrameClock(video);
          await video.play().catch(() => {});
          if (phaseRef.current === "result" || phaseRef.current === "resolving") video.pause();

          const attempt = (): { text: string | null; rotatedHit: boolean; didRotate: boolean; regionWidth: number | null } => {
            if (video.readyState < 2 || !video.videoWidth) {
              return { text: null, rotatedHit: false, didRotate: false, regionWidth: null };
            }
            frame.width = video.videoWidth;
            frame.height = video.videoHeight;
            const fctx = frame.getContext("2d", { willReadFrequently: true });
            if (!fctx) return { text: null, rotatedHit: false, didRotate: false, regionWidth: null };
            fctx.drawImage(video, 0, 0);
            // Upright, then ONE aimed rotate by the MEASURED axis (see
            // decodeCanvasSmart) — never a blind guess.
            const r = decodeCanvasSmart(reader, frame, rotated);
            if (diagRef.current) recordOrientation(r.angle);
            return {
              text: r.text,
              rotatedHit: !!r.text && r.via === "aimed",
              didRotate: r.via === "aimed",
              regionWidth: r.regionWidth,
            };
          };

          let timer: number | null = null;
          const tick = () => {
            if (cancelled) return;
            checkStreamAlive(video);
            // Same gating the native loop uses: never decode behind a sheet,
            // while armed, or once a result is up.
            const idle =
              phaseRef.current !== "scanning" || armedRef.current || sheetOpenRef.current || reviewItemRef.current;
            if (!idle) {
              autoTorchTick(video);
              const t0 = performance.now();
              const { text, rotatedHit, didRotate, regionWidth } = attempt();
              // A decoded frame trivially contained a code; otherwise the
              // estimator's located-region verdict stands in.
              lastStructureRef.current = !!text || regionWidth !== null;
              autoZoomTick(regionWidth, !!text);
              if (diagRef.current) recordDecode(performance.now() - t0, !!text, didRotate);
              if (text) {
                const picked = collect(text, Date.now());
                if (picked) onDetectRef.current(picked);
              }
              if (rotatedHit) {
                // Worth knowing in the field: a read that only came back after
                // the quarter turn is the case that used to be impossible.
                console.debug("[scan] decoded a rotated barcode");
              }
            }
            timer = window.setTimeout(tick, SCAN_ATTEMPT_DELAY_MS);
          };
          tick();
          zxingControls = {
            stop: () => {
              if (timer !== null) window.clearTimeout(timer);
              timer = null;
            },
          };
        }
      } catch (err) {
        setError((err as Error).message);
        setPhase("idle");
      }
    }

    function loop() {
      if (cancelled) return;
      const video = videoRef.current;
      const detector = detectorRef.current;
      if (video) checkStreamAlive(video);
      if (!video || !detector || video.readyState < 2 || phaseRef.current !== "scanning" || armedRef.current || sheetOpenRef.current || reviewItemRef.current) {
        raf = requestAnimationFrame(loop);
        return;
      }
      autoTorchTick(video);
      const t0 = performance.now();
      detector
        .detect(video)
        .then((results) => {
          if (diagRef.current) recordDecode(performance.now() - t0, results.length > 0);
          if (cancelled || results.length === 0) return;
          // A frame can hold several symbols (a book's main code + its price
          // supplement). Taking results[0] made detection ORDER pick the
          // candidate, and an order that flips frame-to-frame starves the
          // two-in-a-row agreement gate — books never scanned. Pick ONE
          // deterministically (retail codes first, then longest) instead.
          const picked = pickDetection(results.map((r) => r.rawValue));
          if (picked) onDetectRef.current(picked);
        })
        .catch(() => {
          // detect() can throw transiently; just keep looping.
        })
        .finally(() => {
          if (!cancelled) raf = requestAnimationFrame(loop);
        });
    }

    void start();

    return () => {
      cancelled = true;
      if (raf !== null) cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      zxingControls?.stop();
      setTorchOn(false);
      setHasTorch(false);
      hasTorchRef.current = false;
      torchOwnerRef.current = null;
      torchAutoRef.current = torchAutoInitial();
    };
    // Acquire once per session (running 0→1), plus once per streamEpoch bump
    // (visibility recovery of a dead stream). Phase flips within a session
    // are handled by phaseRef, not by re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // onDetect is called via onDetectRef so a toast-driven identity change
    // never re-runs this effect (which would restart the camera stream).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, streamEpoch]);

  /** Count rendered frames into the liveness clock. Registered ONCE per video
   *  element (rVFC survives srcObject swaps; re-registering would stack
   *  callbacks). Browsers without rVFC fall back to the currentTime check in
   *  checkStreamAlive. */
  const armFrameClock = useCallback((video: HTMLVideoElement) => {
    frameClockRef.current = frameClockInitial(Date.now());
    if (rvfcArmedRef.current) return;
    const v = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (!v.requestVideoFrameCallback) return;
    rvfcArmedRef.current = true;
    const onFrame = () => {
      frameClockRef.current = noteFrame(frameClockRef.current, Date.now());
      v.requestVideoFrameCallback!(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }, []);

  const lastVideoTimeRef = useRef(-1);
  /** Feed the auto-zoom planner one frame's outcome and apply what it asks
   *  for. Off entirely when the URL carries a manual ?zoom, or when the camera
   *  reports no zoom capability. */
  const autoZoomTick = useCallback((regionWidth: number | null, decoded: boolean) => {
    const range = zoomRangeRef.current;
    if (autoZoomOffRef.current || !range) return;
    const now = Date.now();
    const { state, target } = zoomPlan(zoomRef.current, { regionWidth, decoded }, now);
    zoomRef.current = state;
    if (target === null) return;
    const clamped = Math.min(range.max, Math.max(range.min, target));
    const track = streamRef.current?.getVideoTracks()[0] ?? null;
    void track
      ?.applyConstraints({ advanced: [{ zoom: clamped }] } as unknown as MediaTrackConstraints)
      .then(() => recordZoom(clamped))
      .catch(() => {
        // Refused → stop trying, and SAY so in ?diag=1 rather than silently
        // pretending the lens moved (the swallow class that has bitten this
        // file three times).
        autoZoomOffRef.current = true;
        recordZoom(null);
      });
  }, []);

  /** The watchdog. Called from both decode loops every tick; only judges while
   *  the video is SUPPOSED to be rendering (visible, playing, ready). A stall
   *  re-acquires the stream via streamEpoch — same path the visibility handler
   *  uses, but driven by frames, which cannot lie. */
  const checkStreamAlive = useCallback((video: HTMLVideoElement) => {
    if (document.visibilityState !== "visible") return;
    // Skip only DELIBERATE freezes (result/review sheet pauses the video on
    // purpose). Gating on video.paused instead would blind the watchdog: a
    // dying stream can flip the element to paused/ended all by itself.
    if (phaseRef.current !== "scanning" || sheetOpenRef.current || reviewItemRef.current) return;
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: unknown };
    if (!v.requestVideoFrameCallback && video.currentTime !== lastVideoTimeRef.current) {
      // No rVFC on this browser: advancing currentTime is the frame signal.
      lastVideoTimeRef.current = video.currentTime;
      frameClockRef.current = noteFrame(frameClockRef.current, Date.now());
    }
    const { fire, clock } = shouldReacquire(frameClockRef.current, Date.now());
    frameClockRef.current = clock;
    if (fire) {
      console.warn("[scan] camera stream frozen (no frames) — re-acquiring");
      recordStreamRecovery();
      setStreamEpoch((e) => e + 1);
    }
  }, []);

  /** One throttled luma sample + whatever the machine says to do. Called from
   *  inside both decode loops, only while actively scanning. */
  const autoTorchTick = useCallback((video: HTMLVideoElement) => {
    if (!autoTorchRef.current || autoSuppressedRef.current || !hasTorchRef.current) return;
    if (torchOwnerRef.current === "manual") return;
    const now = Date.now();
    if (now - lastLumaAtRef.current < 500) return;
    lastLumaAtRef.current = now;
    lumaCanvasRef.current ??= document.createElement("canvas");
    const sample = sampleVideoLuma(video, lumaCanvasRef.current, prevLumaFrameRef.current);
    if (sample === null) return;
    prevLumaFrameRef.current = sample.raw;
    recordTorchSample(sample.mean, sample.falloff);
    const { state, turn } = torchAutoSample(
      torchAutoRef.current,
      { ...sample, structure: lastStructureRef.current },
      now,
    );
    torchAutoRef.current = state;
    if (!turn) return;
    const track = streamRef.current?.getVideoTracks()[0] ?? null;
    void setTorch(track, turn === "on").then((ok) => {
      if (!ok) {
        // Never swallow the failure silently — and stop retrying every tick.
        recordTorchEvent("apply-failed");
        autoSuppressedRef.current = true;
        torchAutoRef.current = torchAutoInitial();
        return;
      }
      recordTorchEvent(turn === "on" ? "auto-on" : "auto-off");
      torchOwnerRef.current = turn === "on" ? "auto" : null;
      setTorchOn(turn === "on");
    });
  }, []);

  /** The top-left mode switch: auto-flash on/off. Turning it off also puts
   *  out an auto-lit torch; turning it on forgives a manual override. */
  const toggleAutoTorch = useCallback(() => {
    setAutoTorch((prev) => {
      const next = !prev;
      autoTorchRef.current = next;
      autoSuppressedRef.current = false;
      torchAutoRef.current = torchAutoInitial();
      if (!next && torchOwnerRef.current === "auto") {
        const track = streamRef.current?.getVideoTracks()[0] ?? null;
        void setTorch(track, false);
        torchOwnerRef.current = null;
        setTorchOn(false);
      }
      return next;
    });
  }, []);

  /** The manual button by the shutter: a plain torch toggle. Turning OFF a
   *  torch that auto lit means "not now" — auto stays quiet for the session. */
  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0] ?? null;
    const next = !torchOn;
    const ok = await setTorch(track, next);
    if (!ok) return;
    recordTorchEvent(next ? "manual-on" : "manual-off");
    if (next) {
      torchOwnerRef.current = "manual";
    } else {
      if (torchOwnerRef.current === "auto") autoSuppressedRef.current = true;
      torchOwnerRef.current = null;
      torchAutoRef.current = torchAutoRelease(torchAutoRef.current, Date.now());
    }
    setTorchOn(next);
  }, [torchOn]);

  // FREEZE the viewfinder while the result modal is up or a QR label is being
  // resolved — pausing the <video> element holds the frame you scanned (the
  // stream + lens lock stay live underneath, so re-arm is still instant). A
  // live feed wiggling behind the modal read as "it's still scanning"; the
  // freeze says "got it".
  // "The camera should still be active, but the background frame should be
  // frozen" (the author) — for EVERY blocking sheet, not just the result phase. The
  // review sheet and the expanded photo sheet used to leave the video running
  // behind themselves, which is the flicker the author saw while resizing the drawer.
  const sheetBlocking = sheetOpen || !!reviewItem || phase === "result" || phase === "resolving";
  // A sheet means the scan landed (or review is up) — an AUTO torch has done
  // its job and goes out. A manual torch is the user's call and stays.
  useEffect(() => {
    if (!sheetBlocking || torchOwnerRef.current !== "auto") return;
    torchAutoRef.current = torchAutoRelease(torchAutoRef.current, Date.now());
    const track = streamRef.current?.getVideoTracks()[0] ?? null;
    void setTorch(track, false);
    recordTorchEvent("auto-off");
    torchOwnerRef.current = null;
    setTorchOn(false);
  }, [sheetBlocking]);
  // The + repurpose applies only when an actual SHEET holds the slot — a QR
  // label being resolved ("Reading label…") also freezes, but it is a sub-
  // second wait with no item, so the shutter stays a disabled camera there.
  const plusMode = sheetOpen || !!reviewItem || (phase === "result" && !!pendingBarcode);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (sheetBlocking) {
      v.pause();
    } else if (phase === "scanning" && v.paused && v.srcObject) {
      // Grace-reset the liveness clock: it went stale while DELIBERATELY
      // paused, and must not instantly restart a healthy stream on resume.
      frameClockRef.current = noteResume(frameClockRef.current, Date.now());
      void v.play().catch(() => {
        // Autoplay refusal here is transient; the stream effect owns recovery.
      });
    }
  }, [phase, sheetBlocking]);

  // Modal closed → re-arm the scanner (or back to idle if the camera stopped).
  const rearm = useCallback(() => {
    setPendingBarcode(null);
    setResultItem(null);
    setIngestBusy(false);
    ingestKeyRef.current = null;
    resultItemRef.current = null;
    setPhase(streamRef.current ? "scanning" : "idle");
  }, [setPhase]);

  /** A save happened — count it and re-arm the drawer. WHICH item the drawer
   *  shows is set separately by the shutter path (see drawerItem): a barcode
   *  result belongs to ScanResultModal and must not be re-presented here. */
  const onSaved = useCallback(
    (_item: ScanInboxItem) => {
      setDrawerDismissed(false);
      setSavedCount((n) => {
        persistSession({ count: n + 1 });
        return n + 1;
      });
    },
    [persistSession],
  );

  // The SHUTTER — photograph a no-barcode item. Grab the current frame off
  // the (already live, lens-locked) stream, upload through core-files, and
  // stage a PHOTO inbox item; the vision-identify wire names it detached.
  // Fire-and-forget: scanning never pauses, so the rhythm is
  // shoot → toast → keep walking.
  const saveShot = useCallback(
    async (blob: Blob, stamps: NonNullable<typeof failedShot>["stamps"]) => {
      const file = new File([blob], `scan-${Date.now()}.jpg`, { type: "image/jpeg" });
      const [rec, batchId] = await Promise.all([
        api.uploadFile(activeSlug, file),
        ensureBatchId(),
      ]);
      const item = await api.scanBarcode(activeSlug, {
        source_kind: "photo",
        image_file_id: rec.id,
        scan_area: stamps.areaName ?? undefined,
        target_location_id: stamps.areaId ?? undefined,
        target_container_kind: stamps.container?.kind,
        target_container_id: stamps.container?.id,
        scan_batch_id: batchId ?? undefined,
      });
      onSaved(item);
      setDrawerItem(item);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      // The drawer is the confirmation now — it shows the frame itself, which
      // answers "did that come out?" better than a green note ever did.
      setLastFrame((prev) => (prev ? { ...prev, itemId: item.id } : prev));
    },
    [activeSlug, ensureBatchId, onSaved, qc],
  );

  const takePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || shutterBusy) return;
    if (typeof navigator.vibrate === "function") navigator.vibrate(30);
    scanBeep("shutter");
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    setShutterBusy(true);
    // Stamps freeze at capture time — a retry minutes later must file the shot
    // where you STOOD when you took it, not where you've wandered since. Read
    // through the refs: the areaName memo can lag areaId (two areas sharing a
    // name never rebind it), and the ref is always the live binding.
    const areaIdNow = areaIdRef.current;
    const loc = (locsRef.current ?? []).find((l) => l.id === areaIdNow);
    const stamps = {
      areaName: loc ? (loc.short_name ?? loc.name) : null,
      areaId: areaIdNow,
      container: containerBinRef.current,
    };
    try {
      const blob = await captureFrame(video);
      if (!blob) throw new Error("could not capture a frame");
      setFrame(blob);
      const armed = armRef.current;
      try {
        if (armed) {
          // Every arm uploads the frame and attaches it to an EXISTING item;
          // the mode only decides where it lands.
          const file = new File([blob], `scan-${Date.now()}.jpg`, { type: "image/jpeg" });
          const rec = await api.uploadFile(activeSlug, file);
          const targetId = armed.id;
          const updated =
            armed.mode === "retake"
              ? // A RETAKE replaces the shot the name was derived from, so the
                // name has to be derived again — rerun-ai with the new image is
                // the existing "photograph it again" path, not a new endpoint.
                await api.rerunScanAi(activeSlug, targetId, { imageFileId: rec.id, wrong: true })
              : armed.mode === "catalog"
                ? // The display photo. Identification is untouched — this is an
                  // ADDITION (your shot of the thing) over the stock catalog art.
                  await api.setScanCatalogFile(activeSlug, targetId, rec.id)
                : await api.addScanPhoto(activeSlug, targetId, rec.id);
          onSaved(updated);
          setDrawerItem(updated);
          setLastFrame((prev) => (prev ? { ...prev, itemId: targetId } : prev));
          void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
          // The drawer reads its item from this key too. Without invalidating
          // it, an append/retake renders against a CACHED pre-change copy — the
          // new photo simply doesn't appear in the gallery.
          void qc.invalidateQueries({ queryKey: ["scan-item-live", activeSlug, targetId] });
          // TOP-of-frame note, NOT a bottom toast: a toast here lands exactly
          // on the drawer/shutter and eats the next touch — the same
          // obstruction the filing note was moved to the top for. (Found by
          // the e2e: a swipe right after an armed snap hit the toast, not the
          // drawer.)
          showFilingNote(
            armed.mode === "retake"
              ? "Retaken - reading it again…"
              : armed.mode === "catalog"
                ? "That's the photo for it now."
                : `Added to ${armed.name}.`,
          );
          setArm(null);
          setFailedShot(null);
        } else {
          await saveShot(blob, stamps);
          setFailedShot(null);
        }
      } catch (e) {
        // Only a NEW capture can be retried from the drawer; an arm's target
        // may be gone by then, so those surface as a toast and keep the arm.
        if (!armed) setFailedShot({ blob, stamps });
        toast.error(e instanceof ApiError ? e.message : String(e));
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setShutterBusy(false);
    }
  }, [activeSlug, onSaved, qc, saveShot, showFilingNote, shutterBusy, toast]);

  // The + shutter: while a sheet blocks the viewfinder the shutter can't
  // photograph anything, so it becomes "add a photo to THIS item" — it puts
  // the sheet away (the mini drawer's armed strip takes over as the "still on
  // this scan" indicator), unfreezes the camera, and arms the next shot to
  // attach (the author's design, 2026-08-03).
  const addPhotoFromSheet = useCallback(() => {
    const it = reviewItemRef.current ?? resultItemRef.current ?? drawerItem;
    if (!it) {
      // Lookup still running — queue the arm and close the sheet NOW.
      if (phaseRef.current === "result") {
        earlyIntentRef.current = "photo";
        showFilingNote("One sec - the shutter arms when the scan lands…");
        rearm();
      }
      return;
    }
    // Where the shot lands is the item's business, not a button choice: a
    // barcode item's next shot becomes its DISPLAY photo (the "nice photo" —
    // the catalog render isn't yours), a photo item's next shot joins the
    // record. This is what made the Nice photo button unnecessary.
    armFor(it, it.source_kind === "photo" ? "append" : "catalog");
    setDrawerItem(it);
    setDrawerDismissed(false);
    if (reviewItemRef.current) setReviewItem(null);
    else if (phaseRef.current === "result") rearm();
    else setCollapseNonce((n) => n + 1); // the expanded photo sheet
  }, [armFor, drawerItem, rearm, showFilingNote]);
  // The barcode INGEST — page-owned so the sheet is presentation only. The
  // sheet used to run this itself, which forced its buttons to wait for the
  // row and meant closing it early could orphan the bookkeeping.
  useEffect(() => {
    if (phase !== "result" || !pendingBarcode || ingestKeyRef.current) return;
    const key = `${pendingBarcode}:${Date.now()}`;
    ingestKeyRef.current = key;
    setIngestBusy(true);
    const barcode = pendingBarcode;
    void (async () => {
      try {
        const frame = await (frameBlobRef.current ?? Promise.resolve(null)).catch(() => null);
        const [batchId, frameFileId] = await Promise.all([
          ensureBatchId(),
          frame
            ? api
                .uploadFile(activeSlug, new File([frame], `scan-${barcode}.jpg`, { type: "image/jpeg" }))
                .then((f) => f.id)
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        const it = await api.scanBarcode(activeSlug, {
          barcode,
          scan_area: areaIdRef.current
            ? ((locsRef.current ?? []).find((l) => l.id === areaIdRef.current)?.short_name ??
               (locsRef.current ?? []).find((l) => l.id === areaIdRef.current)?.name)
            : undefined,
          target_location_id: areaIdRef.current ?? undefined,
          target_container_kind: containerBinRef.current?.kind,
          target_container_id: containerBinRef.current?.id,
          scan_batch_id: batchId ?? undefined,
          image_file_id: frameFileId ?? undefined,
        });
        onSaved(it);
        void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
        if (ingestKeyRef.current === key) {
          // Only while the sheet is still on THIS scan: a late-landing ingest
          // must not blank a drawer the user has since filled with a photo.
          setDrawerItem(null); // the sheet owns the slot while it's up
          resultItemRef.current = it;
          setResultItem(it);
        }
        // A queued early intent runs the moment the row exists — the user
        // already moved on; the system catches up.
        const intent = earlyIntentRef.current;
        if (intent) {
          earlyIntentRef.current = null;
          if (intent === "discard") {
            await api.discardScanItem(activeSlug, it.id).catch(() => {});
            showFilingNote("Discarded.");
            void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
          } else {
            armFor(it, intent === "photo" ? (it.source_kind === "photo" ? "append" : "catalog") : "retake");
            setDrawerItem(it);
            setDrawerDismissed(false);
          }
        }
      } catch (e) {
        earlyIntentRef.current = null;
        toast.error(e instanceof ApiError ? e.message : String(e));
        if (phaseRef.current === "result") rearm();
      } finally {
        if (ingestKeyRef.current === key) setIngestBusy(false);
      }
    })();
  }, [phase, pendingBarcode, activeSlug, armFor, ensureBatchId, onSaved, qc, rearm, showFilingNote, toast]);

  // An action taken while the lookup is still running: the sheet closes NOW,
  // the intent executes when the row lands.
  const handleEarly = useCallback(
    (intent: "discard" | "retake") => {
      earlyIntentRef.current = intent;
      showFilingNote(
        intent === "discard"
          ? "Discarding as soon as the scan lands…"
          : "One sec - the shutter arms when the scan lands…",
      );
      rearm();
    },
    [rearm, showFilingNote],
  );

  const retryShot = useCallback(async () => {
    if (!failedShot || retryBusy) return;
    setRetryBusy(true);
    try {
      await saveShot(failedShot.blob, failedShot.stamps);
      setFailedShot(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRetryBusy(false);
    }
  }, [failedShot, retryBusy, saveShot, toast]);

  // What the DRAWER is showing. Deliberately NOT recent[0]: a barcode result is
  // owned by ScanResultModal, which calls the same onSaved, so the drawer used
  // to re-present an item you had just dealt with in the modal - a blocking
  // modal followed by a redundant drawer (the author, on a real shelf, 2026-08-02).
  // The drawer owns the SHUTTER path only; the modal clears it so a stale photo
  // can't linger behind a barcode either. recent/savedCount still count both.
  const lastSaved = drawerItem;

  // The drawer unmounts whenever sort mode takes the bottom, a barcode result
  // takes the slot, or it was dismissed — its sheet can't report "closed" from
  // inside an unmounted component, so clear the flag here or the scrim sticks
  // and detection stays paused.
  const drawerVisible = !sortMode && phase !== "result" && !drawerDismissed && !reviewItem;
  useEffect(() => {
    if (!drawerVisible && !reviewItemRef.current && sheetOpenRef.current) handleSheetExpanded(false);
  }, [drawerVisible, handleSheetExpanded]);

  return createPortal(
    // The viewfinder keeps running behind every modal this page opens, so they
    // must stay CARDS on a phone rather than claiming the screen - declared
    // once here instead of per modal (see platform-web/live-surface.tsx).
    <LiveSurfaceProvider>
    <div className="fixed inset-0 z-40 bg-black">
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* Shutter flash — a quick white blink confirming the capture. */}
      {flash && <div className="absolute inset-0 bg-white/80 pointer-events-none" />}

      {/* Scrim while a sheet is open (the drawer's full sheet, or a barcode
          result): the mock's rule — blocking comes from the scrim + the paused
          scanner, not from a different component. The positioned chrome
          (top bar, bottom stack) paints above it; the shutter stays visible. */}
      {(sheetOpen || !!reviewItem || (phase === "result" && !!pendingBarcode)) && (
        <div className="absolute inset-0 bg-black/45 pointer-events-none" />
      )}

      {/* "Photo saved" — top of frame, over the dark preview, tap-through.
          Doesn't touch the bottom controls (the author: the toast there blocked
          rapid capture). */}
      {/* Filing feedback — top of frame, over the dark preview, tap-through. The
          global toast rendered at the BOTTOM, directly over the shutter (see the
          savedNote comment). Same slot, same reason. */}
      {filingNote && (
        <div
          className="absolute inset-x-0 z-30 flex justify-center pointer-events-none px-4"
          style={{ top: UNDER_TOP_CHROME }}
        >
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-600/90 text-white text-xs font-medium px-3 py-1.5 shadow-lg backdrop-blur-sm max-w-[92%]">
            <MapPin size={13} className="shrink-0" />
            <span className="truncate">{filingNote}</span>
          </div>
        </div>
      )}

      {/* Reading a label — the preview is frozen while the server tells us what
          this QR points at. Says so, exactly when it's true. */}
      {resolvingNote && (
        <div
          className="absolute inset-x-0 z-30 flex justify-center pointer-events-none px-4"
          style={{ top: UNDER_TOP_CHROME }}
        >
          <div className="inline-flex items-center gap-2 rounded-full bg-black/70 text-white text-xs font-medium px-3 py-1.5 shadow-lg backdrop-blur-sm">
            <Loader2 size={13} className="shrink-0 animate-spin text-cobble-300" /> Reading label…
          </div>
        </div>
      )}

      {/* ── top chrome: torch · where-you're-filing · modes · close ─────
          The filing chip is the only thing here that carries a NAME, so it's the
          only thing that gets to grow: it's flex-1 and everything else is
          shrink-0. It used to be squeezed to its padding by a row of fixed-width
          buttons plus a "scanning" chip that only ever restated the reticle.
      */}
      <div
        className="absolute top-0 inset-x-0 flex items-center gap-1.5 p-4"
        style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
      >
        {running && hasTorch ? (
          <button
            type="button"
            onClick={toggleAutoTorch}
            aria-label="Automatic flash"
            title={
              autoTorch
                ? "Auto flash is ON - the light comes on by itself when the scene is dark. Tap to turn auto off."
                : "Auto flash is OFF. Tap to let the light come on by itself when it's dark."
            }
            className={`relative rounded-full p-2.5 shrink-0 ${
              torchOn && autoTorch
                ? "bg-amber-400 text-slate-900"
                : autoTorch
                  ? "bg-black/50 text-white hover:bg-black/70"
                  : "bg-black/50 text-white/35 hover:bg-black/70"
            }`}
          >
            <Flashlight size={18} />
            <span
              className={`absolute -bottom-0.5 -right-0.5 rounded-full px-1 text-[8px] font-bold leading-[13px] ${
                autoTorch ? "bg-cobble-500 text-white" : "bg-white/25 text-white/60"
              }`}
            >
              A
            </span>
          </button>
        ) : (
          <span className="w-10 shrink-0" />
        )}
        {containerBin ? (
          /* Container bin — you scanned a machine/asset QR, so every scan files
             INTO it (a placement). Tap to clear. */
          <button
            type="button"
            onClick={() => {
              setContainerBin(null);
              containerBinRef.current = null;
            }}
            title="Scanning into this container - tap to clear"
            className="inline-flex items-center gap-1.5 bg-cobble-600/85 hover:bg-cobble-600 rounded-full px-3 py-1.5 text-white text-xs min-w-0 flex-1"
          >
            <Package size={13} className="shrink-0" />
            <span className="truncate min-w-0 flex-1 text-left">
              Into {containerName ?? "container"}
            </span>
            <X size={12} className="text-white/70 shrink-0" />
          </button>
        ) : (
          /* Area chip — where you're standing; stamped on every save. */
          <button
            type="button"
            onClick={() => setAssignOpen(true)}
            className="inline-flex items-center gap-1.5 bg-black/50 hover:bg-black/70 rounded-full px-3 py-1.5 text-white text-xs min-w-0 flex-1"
          >
            <MapPin
              size={13}
              className={`shrink-0 ${areaName ? "text-emerald-400" : "text-white/60"}`}
            />
            <span className="truncate min-w-0 flex-1 text-left">{areaName ?? "Set area"}</span>
          </button>
        )}
        {/* Move mode — scan a tracked item → it MOVES to the active bin,
            no triage stop (needs an area set to have somewhere to move to). */}
        <button
          type="button"
          onClick={toggleMoveMode}
          aria-pressed={moveMode}
          title="Move mode: scanning something you already track moves it to the active area"
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs shrink-0 ${
            moveMode ? "bg-emerald-500 text-white" : "bg-black/50 text-white/70 hover:bg-black/70"
          }`}
        >
          <ArrowLeftRight size={13} /> Move
        </button>
        {/* Sort mode (Live Sort) — scan a thing, get told which bin it goes
            in, tap Done. The streaming put-away session, on the camera. */}
        <button
          type="button"
          onClick={toggleSortMode}
          aria-pressed={sortMode}
          title="Sort mode: every scan gets a destination bin directive - put it there, tap Done, next"
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs shrink-0 ${
            sortMode ? "bg-cobble-600 text-white" : "bg-black/50 text-white/70 hover:bg-black/70"
          }`}
        >
          <Zap size={13} /> Sort
        </button>
        <button
          type="button"
          onClick={close}
          aria-label="Close scanner"
          title="Close"
          className="bg-black/50 rounded-full p-2.5 text-white hover:bg-black/70 shrink-0"
        >
          <X size={18} />
        </button>
      </div>

      {/* Resume — a recent session (same workspace, < 4h) can continue its
          batch + area instead of fragmenting the walk-around. */}
      {resumable && savedCount === 0 && (
        <div
          className="absolute inset-x-0 flex justify-center"
          style={{ top: UNDER_TOP_CHROME }}
        >
          <div className="flex items-center gap-1 bg-black/55 rounded-full pl-3 pr-1 py-1 text-white text-xs">
            <button type="button" onClick={resume} className="inline-flex items-center gap-1.5 py-1">
              <ScanLine size={13} className="text-emerald-400" />
              Resume session ({resumable.count} {resumable.count === 1 ? "item" : "items"})
            </button>
            <button
              type="button"
              onClick={() => {
                setResumable(null);
                try {
                  localStorage.removeItem(sessionKey(activeSlug));
                } catch {
                  /* ignore */
                }
              }}
              aria-label="Dismiss resume"
              className="p-1.5 rounded-full hover:bg-black/40 text-white/70"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* ── reticle + caption ────────────────────────────────────────── */}
      {phase === "scanning" && !sheetOpen && !reviewItem && (
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 pointer-events-none">
          <div className="mx-8 border-2 border-accent/80 rounded-xl h-40" />
          <div className="mt-4 text-center text-white/85 text-sm px-8 [text-shadow:0_1px_2px_rgba(0,0,0,0.7)]">
            {supported === false
              ? "Hold a barcode steady, snap a photo, or type the UPC below."
              : "Point at a barcode or a Cobblr QR label — or hit the shutter to photograph it."}
          </div>
        </div>
      )}

      {/* ── permission / error state ─────────────────────────────────── */}
      {!running && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/90 text-white p-6 text-center">
          <Camera size={28} className="opacity-80" />
          <div className="text-sm font-medium">Camera unavailable</div>
          {error && (
            <div className="text-xs text-white/70 max-w-xs">
              {error}  - check the browser&apos;s camera permission for this site.
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setPhase("scanning");
            }}
            className="inline-flex items-center gap-2 rounded-full bg-cobble-600 hover:bg-cobble-700 px-4 py-2 text-sm font-medium"
          >
            <Camera size={16} /> Try again
          </button>
          <button type="button" onClick={close} className="text-xs text-white/70 underline">
            Close
          </button>
        </div>
      )}

      {/* ── bottom chrome: session chip + manual UPC + action bar ────── */}
      <div
        className="absolute bottom-0 inset-x-0 p-4 space-y-3"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        {/* SORT MODE banner — the directive lives ON the viewfinder; the
            camera never pauses and no modal opens. */}
        {sortMode && (sortEntry || sortBusy || sortLast) && (
          <div className="max-w-md mx-auto rounded-2xl bg-black/70 backdrop-blur-sm px-4 py-3 text-white space-y-2">
            {sortEntry ? (
              <>
                <div className="text-xs text-white/70 truncate">
                  {sortEntry.name ?? "Unidentified item"}
                  {sortEntry.quantity > 1 && ` ×${sortEntry.quantity}`}
                </div>
                {sortEntry.directive.kind === "bin" ? (
                  <>
                    <div className="flex items-center gap-2 text-2xl font-bold">
                      <ArrowRight size={24} className="text-cobble-300 shrink-0" />
                      <MapPin size={22} className="text-cobble-300 shrink-0" />
                      <span className="truncate">{sortEntry.directive.location_name}</span>
                    </div>
                    <div className="text-xs text-white/70">
                      {sortEntry.directive.via === "sticky"
                        ? "Same as the last one."
                        : `${sortEntry.directive.sibling_count} similar item${
                            sortEntry.directive.sibling_count === 1 ? "" : "s"
                          } already here`}
                    </div>
                  </>
                ) : sortEntry.directive.kind === "bind-offer" ? (
                  <>
                    <div className="flex items-center gap-2 text-2xl font-bold">
                      <ArrowRight size={24} className="text-cobble-300 shrink-0" />
                      <MapPin size={22} className="text-cobble-300 shrink-0" />
                      <span className="truncate">{sortEntry.directive.location_name}</span>
                    </div>
                    <div className="text-xs text-white/70">
                      Starts your <span className="text-white font-medium">{sortEntry.directive.proposed_name}</span>{" "}
                      bin - Done names it "{sortEntry.directive.location_name} · {sortEntry.directive.proposed_name}".
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-xl font-bold text-amber-300">
                      <ArrowRight size={22} className="shrink-0" />
                      <span className="truncate">
                        {sortEntry.directive.location_name ?? "Unsorted bin"}
                      </span>
                    </div>
                    <div className="text-xs text-white/70">
                      No confident match - park it, it stays findable in the inbox.
                    </div>
                  </>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => confirmSort()}
                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-cobble-600 hover:bg-cobble-700 text-white text-base font-semibold px-4 py-3"
                    data-testid="camera-sort-confirm"
                  >
                    <Check size={18} /> Done, next
                  </button>
                  <button
                    type="button"
                    onClick={() => setSortEntry(null)}
                    title="Skip - leave it unsorted for now"
                    className="rounded-xl bg-white/10 hover:bg-white/20 px-3 py-3"
                  >
                    <SkipForward size={18} />
                  </button>
                </div>
                <div className="text-[10px] text-white/50 text-center">
                  scan a bin's QR label to file it somewhere else
                </div>
              </>
            ) : sortBusy ? (
              <div className="flex items-center gap-2 text-sm">
                <Loader2 size={16} className="animate-spin text-cobble-300" /> Finding it a home…
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs">
                <Zap size={14} className="text-cobble-300 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  Sorted {sortCount}  - scan the next item
                </span>
                <label
                  className="inline-flex items-center gap-1 text-white/70 shrink-0"
                  title="The next scan confirms the current directive - zero taps in steady state; Undo covers mistakes"
                >
                  <input type="checkbox" checked={sortImplicit} onChange={toggleSortImplicit} />
                  auto-Done
                </label>
                {sortLast && (
                  <button
                    type="button"
                    onClick={undoSort}
                    className="inline-flex items-center gap-1 text-cobble-200 hover:text-white shrink-0"
                  >
                    <Undo2 size={13} /> Undo {sortLast.name ?? "last"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {undoableMoves.length > 0 && (
          <div className="flex items-center gap-2 bg-black/55 rounded-full px-3 py-2 text-white text-xs max-w-md mx-auto">
            <ArrowLeftRight size={14} className="text-emerald-400 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Moved {undoableMoves[undoableMoves.length - 1]!.title}
              {undoableMoves.length > 1 && ` (+${undoableMoves.length - 1} more)`}
            </span>
            <button
              type="button"
              disabled={undoMove.isPending}
              onClick={() => undoMove.mutate(undoableMoves[undoableMoves.length - 1]!)}
              className="inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200 shrink-0 disabled:opacity-50"
            >
              <Undo2 size={13} /> Undo last {undoableMoves.length > 1 ? undoableMoves.length : ""}
            </button>
          </div>
        )}
        {/* The capture drawer — the one "what just happened" surface. Replaces
            the last-saved pill, the failed-shot pill and the top-of-frame saved
            note. Suppressed in sort mode (the directive card owns the bottom
            there) and behind the result modal. */}
        {/* A barcode result renders HERE, in the same slot as the capture
            drawer, so the camera has ONE surface whatever you pointed it at
            (the author, 2026-08-03). It is the same content as before - all the
            enrichment, tracked-match and destination behaviour is untouched -
            just no longer inside a centred dialog over the viewfinder. */}
        {phase === "result" && pendingBarcode && (
            <ScanResultModal
            barcode={pendingBarcode}
            item={resultItem}
            pending={ingestBusy}
            scanArea={areaName}
            scanAreaId={areaId}
            getFrameBlob={() => frameBlobRef.current}
            scanTarget={{
              into: params.get("into"),
              module: params.get("module"),
              kind: params.get("kind"),
              label: params.get("label"),
            }}
            onRetake={(it) => armFromSheet(it, "retake")}
            onAddPhoto={(it) => armFromSheet(it, it.source_kind === "photo" ? "append" : "catalog")}
            onEarly={handleEarly}
            onClose={(_outcome, _current) => {
              // Save & next / Discard / an arm are the only exits, and none of
              // them warrants a mini-drawer echo: the item is in the inbox
              // (the sheet says so) and "I don't see the point of a small
              // drawer" for a barcode (the author). The drawer still appears for the
              // + flow, where it is the armed working surface.
              rearm();
            }}
            moveMode={moveMode}
            onAttached={(r, m, mode) => {
              if (mode === "move") {
                setMoveStack((s) => [
                  ...s,
                  { itemId: r.itemId, match: m, prevLocationId: r.prevLocationId, title: r.entityTitle },
                ]);
              }
            }}
          />
        )}
        {/* Review mode: the same Scanned sheet, reopened on an existing item.
            No ingest, no qty bump - edits land straight on the drawer item. */}
        {reviewItem && phase !== "result" && (
          <ScanResultModal
            key={reviewItem.id}
            barcode={reviewItem.barcode_text ?? ""}
            item={reviewItem}
            scanArea={areaName}
            scanAreaId={areaId}
            scanTarget={{
              into: params.get("into"),
              module: params.get("module"),
              kind: params.get("kind"),
              label: params.get("label"),
            }}
            onRetake={(it) => armFromSheet(it, "retake")}
            onAddPhoto={(it) => armFromSheet(it, it.source_kind === "photo" ? "append" : "catalog")}
            onClose={(outcome, current) => {
              setReviewItem(null);
              if (outcome === "handled") {
                setDrawerItem(null);
                setDrawerDismissed(true);
              } else if (current) {
                setDrawerItem(current);
              }
            }}
            moveMode={moveMode}
            onAttached={(r, m, mode) => {
              if (mode === "move") {
                setMoveStack((s) => [
                  ...s,
                  { itemId: r.itemId, match: m, prevLocationId: r.prevLocationId, title: r.entityTitle },
                ]);
              }
            }}
          />
        )}
        {diagOpen && (
          <ScanDiagPanel
            getTrack={() => streamRef.current?.getVideoTracks()[0] ?? null}
            onClose={() => setDiagOpen(false)}
          />
        )}
        {drawerVisible && (
          <ScanCaptureDrawer
            slug={activeSlug}
            item={lastSaved}
            localFrameUrl={lastFrame?.url ?? null}
            localFrameItemId={lastFrame?.itemId ?? null}
            sessionCount={savedCount}
            batchId={batchIdRef.current}
            failed={
              failedShot
                ? { retry: () => void retryShot(), discard: () => setFailedShot(null), busy: retryBusy }
                : null
            }
            undoBusy={undoBusy}
            armed={arm?.mode ?? null}
            onCancelArm={() => setArm(null)}
            onAddPhoto={(it) => armFor(it, "append")}
            onRetake={(it) => armFor(it, "retake")}
            onPickLocation={(it) => setPlacingItem(it)}
            sessionLocationLabel={areaName ?? null}
            containerLabel={containerBin ? (containerName ?? "this container") : null}
            onDismiss={() => setDrawerDismissed(true)}
            onExpandedChange={handleSheetExpanded}
            collapseNonce={collapseNonce}
            onExpandBarcode={(it) => setReviewItem(it)}
            onConfirm={() => {
              // THE SCANNER NEVER FILES (the author, ruling 2026-08-05, restating
              // 2026-08-03). This used to POST confirmScanItem with the
              // matchmaker's first candidate — the same act as the ADD TO chips
              // that were removed for exactly this reason, just wearing a
              // different label. Filing is a decision made in the inbox, where
              // you can see everything at once; the camera's job ends at
              // capture. So this is an affirmative dismiss: the edits
              // (quantity, name, location) already saved as they were made, and
              // the item stays in the inbox.
              setDrawerItem(null);
              setDrawerDismissed(true);
              toast.success("Kept in your scan inbox.");
            }}
            onUndo={(it) => {
              setUndoBusy(true);
              void api
                .discardScanItem(activeSlug, it.id)
                .then(() => {
                  setDrawerItem((prev) => (prev?.id === it.id ? null : prev));
                  setLastFrame((prev) => (prev?.itemId === it.id ? (URL.revokeObjectURL(prev.url), null) : prev));
                  void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
                  toast.success("Undone - removed from the inbox");
                })
                .catch((e) => toast.error(e instanceof ApiError ? e.message : String(e)))
                .finally(() => setUndoBusy(false));
            }}
          />
        )}
        {/* Hidden while a sheet is open: you already scanned/opened something,
            so "Or type the UPC" is dead weight under the sheet - the row (and
            its height) comes back the moment the sheet closes. */}
        {!(sheetOpen || !!reviewItem || (phase === "result" && !!pendingBarcode)) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = manual.trim();
            if (!v) return;
            setManual("");
            setPendingBarcode(v);
            setPhase("result");
          }}
          className="flex gap-2 items-center bg-black/55 rounded-full px-3 py-2 max-w-md mx-auto"
        >
          <ScanLine size={16} className="text-white/60 shrink-0" />
          <input
            type="text"
            inputMode="numeric"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Or type the UPC"
            className="flex-1 min-w-0 bg-transparent text-white placeholder-white/50 text-sm font-mono px-1 py-0.5 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!manual.trim()}
            className="rounded-full bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1 text-sm font-medium disabled:opacity-50 shrink-0"
          >
            Scan
          </button>
        </form>
        )}

        {/* Assign · SHUTTER · Done — the bottom bar. The shutter is the
            photo path for items with no barcode; barcodes never need it. */}
        <div className="flex items-center justify-between max-w-md mx-auto px-2">
          <button
            type="button"
            onClick={() => setAssignOpen(true)}
            className="inline-flex items-center gap-1.5 bg-black/55 hover:bg-black/70 rounded-full px-4 py-2.5 text-white text-sm font-medium w-24 justify-center"
          >
            <MapPin size={15} /> Assign
          </button>
          {running && hasTorch && (
            <button
              type="button"
              onClick={() => void toggleTorch()}
              aria-label="Flashlight"
              title="Flashlight"
              className={`rounded-full p-2 shrink-0 ${
                torchOn ? "bg-amber-400 text-slate-900" : "bg-black/55 text-white hover:bg-black/70"
              }`}
            >
              <Flashlight size={16} />
            </button>
          )}
          {/* Three shutter states, and never a dead one:
                camera — photograph a NEW item;
                +      — a sheet is blocking the viewfinder, so a real capture
                         is impossible; the press puts the sheet away, unfreezes
                         the camera and arms the next shot to ATTACH to that
                         sheet's item (the author's design, 2026-08-03);
                armed  — gold ring, camera icon: the next press attaches. The
                         words live in the drawer's strip — the paperclip icon
                         is gone ("I have literally no idea what the paperclip
                         icon means"). */}
          <button
            type="button"
            onClick={() => (plusMode ? addPhotoFromSheet() : void takePhoto())}
            disabled={
              !running ||
              shutterBusy ||
              (plusMode ? false : phase !== "scanning")
            }
            aria-label={plusMode ? "Add a photo to this item" : "Take a photo of the item"}
            title={
              plusMode
                ? "Add a photo to this item - the sheet gets out of the way and the next shot attaches"
                : "Photograph the item (no barcode needed)"
            }
            className={
              "w-[72px] h-[72px] rounded-full disabled:opacity-40 flex items-center justify-center shadow-lg " +
              (armedRef.current ? "bg-slate-900 ring-4 ring-cobble-400" : "bg-white/95 hover:bg-white")
            }
          >
            <span
              className={
                "w-[60px] h-[60px] rounded-full border-[3px] flex items-center justify-center " +
                (armedRef.current ? "border-cobble-400" : "border-slate-900/80")
              }
            >
              {shutterBusy ? (
                <Loader2 size={24} className="text-slate-900 animate-spin" />
              ) : plusMode ? (
                <Plus size={28} className="text-slate-900" data-testid="shutter-plus" />
              ) : (
                <Camera size={26} className={armedRef.current ? "text-cobble-300" : "text-slate-900"} />
              )}
            </span>
          </button>
          {running && hasTorch && <span className="w-8 shrink-0" />}
          <button
            type="button"
            onClick={() => {
              // Done → the FULL grouped inbox (all sessions as sections),
              // scrolled to the one just scanned — not scoped to it, which hid
              // earlier sessions (the author). Nothing saved → just close.
              if (savedCount > 0 && batchIdRef.current) {
                navigate(`/scan#s-${batchIdRef.current}`);
              } else {
                close();
              }
            }}
            className="inline-flex items-center gap-1.5 bg-black/55 hover:bg-black/70 rounded-full px-4 py-2.5 text-white text-sm font-medium w-24 justify-center"
          >
            <Check size={15} /> Done
          </button>
        </div>
      </div>

      {/* Assign sheet — pick the scan area. A z-50 Modal, so it stacks over
          the z-40 scanner overlay like the result modal does. */}
      {/* Per-item location override — the same LocationChipPicker the Assign
          sheet uses, writing to THIS item instead of the session. */}
      {placingItem && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end" onClick={() => setPlacingItem(null)}>
          <div
            className="w-full max-h-[75dvh] overflow-y-auto rounded-t-2xl bg-surface dark:bg-slate-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <div className="text-sm font-semibold text-content dark:text-mortar-100 flex-1 min-w-0 truncate">
                Where does this one go?
              </div>
              <button type="button" onClick={() => setPlacingItem(null)} className="text-faint hover:text-content dark:hover:text-mortar-100">
                <X size={16} />
              </button>
            </div>
            <LocationChipPicker
              value={placingItem.target_location_id ?? null}
              kind="area"
              onChange={(id) => {
                const it = placingItem;
                setPlacingItem(null);
                void api
                  .updateScanItem(activeSlug, it.id, { target_location_id: id })
                  .then((updated) => {
                    onSaved(updated);
                    setDrawerItem(updated);
                    void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
                    void qc.invalidateQueries({ queryKey: ["scan-item-live", activeSlug, it.id] });
                  })
                  .catch((e) => toast.error(e instanceof ApiError ? e.message : String(e)));
              }}
            />
          </div>
        </div>
      )}

      {assignOpen && (
        <Modal open onClose={() => setAssignOpen(false)} title="Scan area" size="sm">
          <div className="space-y-3">
            <p className="text-xs text-muted dark:text-slate-400">
              Stamped on everything you scan or photograph this session, so triage
              knows where it lives.
            </p>
            <LocationChipPicker value={areaId} onChange={setAreaId} kind="area" />
            <div className="flex justify-end gap-2 pt-1">
              {areaId && (
                <button
                  type="button"
                  onClick={() => setAreaId(null)}
                  className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={() => setAssignOpen(false)}
                className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white"
              >
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}

      {binAdjust && (
        <BinAdjustModal
          locationId={binAdjust.locationId}
          locationName={binAdjust.locationName}
          item={binAdjust.item}
          onClose={() => {
            setBinAdjust(null);
            setPhase("scanning");
          }}
          onAddSomethingElse={() => {
            // The bin is gaining a second SKU — flip to the filing flow: set it
            // as the active bin and keep scanning into it.
            setAreaId(binAdjust.locationId);
            toast.success(`Filing into ${binAdjust.locationName} — scan the new item`);
            setBinAdjust(null);
            setPhase("scanning");
          }}
        />
      )}
      {ambiguous && (
        <ScanAmbiguityModal
          scanKey={ambiguous.key}
          candidates={ambiguous.candidates}
          truncated={ambiguous.truncated}
          onPick={(c) => {
            setAmbiguous(null);
            void routeResolvedRef.current(
              { entity_kind: c.entity_kind, entity_id: c.entity_id },
              c.detail_path,
            );
          }}
          onClose={() => {
            setAmbiguous(null);
            setPhase("scanning");   // dismissing re-arms rather than stranding the camera
          }}
        />
      )}
    </div>
    </LiveSurfaceProvider>,
    document.body,
  );
}
