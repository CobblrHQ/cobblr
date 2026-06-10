// /scan/camera — full-screen immersive scanner, companion app-grade.
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
// ONE screen, BOTH intake paths (the companion app combination):
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
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Flashlight, Loader2, MapPin, ScanLine, X } from "lucide-react";
import { Modal, usePageTitle, useToast } from "@cobblr/platform-web";
import { ApiError, api, type ScanInboxItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { LocationPicker } from "../components/LocationPicker";
import {
  NATIVE_FORMATS,
  acquireScannerStream,
  cameraHasTorch,
  createBarcodeReader,
  setTorch,
} from "../lib/barcodeScanner";
import { ScanResultModal } from "./ScanResultModal";

// BarcodeDetector type — not in lib.dom.d.ts as of TS 5.7. Local shim.
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): {
    detect: (source: HTMLVideoElement | ImageBitmap | HTMLCanvasElement) => Promise<
      Array<{ rawValue: string; format?: string }>
    >;
  };
  getSupportedFormats(): Promise<string[]>;
}

type Phase = "idle" | "scanning" | "result";

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
  // Preserve the instance-scan target (?into=…) so the modal + return keep it.
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const backToScan = `/scan${params.toString() ? `?${params}` : ""}`;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const detectorRef = useRef<InstanceType<BarcodeDetectorCtor> | null>(null);
  const lastSeenRef = useRef<{ value: string; at: number } | null>(null);
  // Agreement gate: require the SAME code on two consecutive decodes before we
  // accept it. The native BarcodeDetector loop runs every animation frame, so a
  // single noisy frame can misread a barcode that isn't even in view — demanding
  // two-in-a-row throws those away and stops the scanner firing too eagerly.
  const candidateRef = useRef<{ value: string; count: number } | null>(null);
  // phaseRef mirrors `phase` so the decode callbacks (set up once) read the
  // live value — once we're in the result modal, decodes are ignored. That
  // guard IS the "stop scanning the same thing over and over" fix.
  const phaseRef = useRef<Phase>("scanning");

  // Auto-start: mount straight into "scanning" so the lens turns on with no
  // extra tap. "idle" is now only the permission-denied / camera-error state.
  const [phase, setPhaseState] = useState<Phase>("scanning");
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const [supported, setSupported] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<ScanInboxItem[]>([]);
  const [manual, setManual] = useState("");
  const [pendingBarcode, setPendingBarcode] = useState<string | null>(null);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Scan area — stamped as `scan_area` (free text, the location's name) on
  // every item saved this session, barcode and photo alike. Picked via the
  // Assign sheet (LocationPicker over core-locations).
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [areaId, setAreaId] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [shutterBusy, setShutterBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const locations = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const areaName = useMemo(() => {
    if (!areaId) return null;
    const loc = (locations.data?.items ?? []).find((l) => l.id === areaId);
    return loc ? (loc.short_name ?? loc.name) : null;
  }, [areaId, locations.data]);

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
  // (24-char base64url — see core-labels-qr's token mint), and that's a
  // navigation, not a product — route it to the /qr resolver, which lands
  // on the labeled entity. Without this, scanning your own label staged a
  // junk "no catalog match" inbox item.
  const onDetect = useCallback(
    (rawIn: string) => {
      if (phaseRef.current !== "scanning") return;
      const raw = rawIn.trim();
      if (!raw) return;
      // Require two consecutive identical decodes — a lone misread never lands.
      const cand = candidateRef.current;
      if (cand && cand.value === raw) {
        cand.count += 1;
      } else {
        candidateRef.current = { value: raw, count: 1 };
        return;
      }
      if (cand.count < 2) return;
      candidateRef.current = null;
      const last = lastSeenRef.current;
      if (last && last.value === raw && Date.now() - last.at < 2_000) return;
      lastSeenRef.current = { value: raw, at: Date.now() };
      if (typeof navigator.vibrate === "function") navigator.vibrate(70);
      const qrLabel = /^https?:\/\/[^/]+\/qr\/([A-Za-z0-9_-]{16,})$/.exec(raw);
      if (qrLabel) {
        setPhase("idle"); // release the camera before leaving
        navigate(`/qr/${qrLabel[1]}`);
        return;
      }
      setPendingBarcode(raw);
      setPhase("result");
    },
    [setPhase, navigate],
  );

  // Start / stop the camera. Acquire ONE lens-locked stream and keep it alive
  // for the whole session; the phase guard pauses/resumes decoding so re-arm
  // after a scan is instant and the lens never switches.
  const running = phase !== "idle";
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
      setHasTorch(cameraHasTorch(track));
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
            await videoRef.current.play();
          }
          const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
            .BarcodeDetector!;
          detectorRef.current = new Detector({ formats: NATIVE_FORMATS });
          loop();
        } else {
          const reader = createBarcodeReader();
          zxingControls = await reader.decodeFromStream(
            stream,
            videoRef.current!,
            (result) => {
              if (!cancelled && result) onDetect(result.getText());
            },
          );
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
      if (!video || !detector || video.readyState < 2 || phaseRef.current !== "scanning") {
        raf = requestAnimationFrame(loop);
        return;
      }
      detector
        .detect(video)
        .then((results) => {
          if (cancelled || results.length === 0) return;
          onDetect(results[0]!.rawValue);
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
    };
    // Acquire once per session (running 0→1). Phase flips within a session
    // are handled by phaseRef, not by re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, onDetect, setPhase]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0] ?? null;
    const next = !torchOn;
    const ok = await setTorch(track, next);
    if (ok) setTorchOn(next);
  }, [torchOn]);

  // FREEZE the viewfinder while the result modal is up — pausing the <video>
  // element holds the frame you scanned (the stream + lens lock stay live
  // underneath, so re-arm is still instant). A live feed wiggling behind the
  // modal read as "it's still scanning"; the freeze says "got it".
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (phase === "result") {
      v.pause();
    } else if (phase === "scanning" && v.paused && v.srcObject) {
      void v.play().catch(() => {
        // Autoplay refusal here is transient; the stream effect owns recovery.
      });
    }
  }, [phase]);

  // Modal closed → re-arm the scanner (or back to idle if the camera stopped).
  const rearm = useCallback(() => {
    setPendingBarcode(null);
    setPhase(streamRef.current ? "scanning" : "idle");
  }, [setPhase]);

  const onSaved = useCallback(
    (item: ScanInboxItem) => {
      setRecent((prev) => [item, ...prev.filter((p) => p.id !== item.id)].slice(0, 8));
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
  const takePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || shutterBusy) return;
    if (typeof navigator.vibrate === "function") navigator.vibrate(30);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    setShutterBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85),
      );
      if (!blob) throw new Error("could not capture a frame");
      const file = new File([blob], `scan-${Date.now()}.jpg`, { type: "image/jpeg" });
      const [rec, batchId] = await Promise.all([
        api.uploadFile(activeSlug, file),
        ensureBatchId(),
      ]);
      const item = await api.scanBarcode(activeSlug, {
        source_kind: "photo",
        image_file_id: rec.id,
        scan_area: areaName ?? undefined,
        scan_batch_id: batchId ?? undefined,
      });
      onSaved(item);
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      toast.success("Photo saved — AI is identifying it in the inbox");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setShutterBusy(false);
    }
  }, [activeSlug, areaName, ensureBatchId, onSaved, qc, shutterBusy, toast]);

  const lastSaved = recent[0] ?? null;

  return createPortal(
    <div className="fixed inset-0 z-40 bg-black">
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* Shutter flash — a quick white blink confirming the capture. */}
      {flash && <div className="absolute inset-0 bg-white/80 pointer-events-none" />}

      {/* ── top chrome: torch · area chip · status · close ──────────── */}
      <div
        className="absolute top-0 inset-x-0 flex items-center justify-between gap-2 p-4"
        style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
      >
        {running && hasTorch ? (
          <button
            type="button"
            onClick={toggleTorch}
            aria-label="Torch"
            title="Torch"
            className={`rounded-full p-2.5 shrink-0 ${torchOn ? "bg-amber-400 text-slate-900" : "bg-black/50 text-white hover:bg-black/70"}`}
          >
            <Flashlight size={18} />
          </button>
        ) : (
          <span className="w-10 shrink-0" />
        )}
        {/* Area chip — where you're standing; stamped on every save. */}
        <button
          type="button"
          onClick={() => setAssignOpen(true)}
          className="inline-flex items-center gap-1.5 bg-black/50 hover:bg-black/70 rounded-full px-3 py-1.5 text-white text-xs min-w-0"
        >
          <MapPin size={13} className={areaName ? "text-emerald-400" : "text-white/60"} />
          <span className="truncate max-w-[40vw]">{areaName ?? "Set area"}</span>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {running && (
            <span className="inline-flex items-center gap-1.5 bg-black/50 rounded-full px-2.5 py-1 text-white text-xs">
              <span
                className={`w-2 h-2 rounded-full ${phase === "scanning" ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`}
              />
              {phase === "scanning" ? "scanning" : "paused"}
            </span>
          )}
          <button
            type="button"
            onClick={close}
            aria-label="Close scanner"
            title="Close"
            className="bg-black/50 rounded-full p-2.5 text-white hover:bg-black/70"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Resume — a recent session (same workspace, < 4h) can continue its
          batch + area instead of fragmenting the walk-around. */}
      {resumable && savedCount === 0 && (
        <div
          className="absolute inset-x-0 flex justify-center"
          style={{ top: "max(4.5rem, calc(env(safe-area-inset-top) + 3.5rem))" }}
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
      {phase === "scanning" && (
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 pointer-events-none">
          <div className="mx-8 border-2 border-accent/80 rounded-xl h-40" />
          <div className="mt-4 text-center text-white/85 text-sm px-8 [text-shadow:0_1px_2px_rgba(0,0,0,0.7)]">
            {supported === false
              ? "Hold the barcode steady in the frame — or type the UPC below."
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
              {error} — check the browser&apos;s camera permission for this site.
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
        {lastSaved && (
          <Link
            to={batchIdRef.current ? `/scan?batch=${batchIdRef.current}` : backToScan}
            className="flex items-center gap-2 bg-black/55 rounded-full px-3 py-2 text-white text-xs max-w-md mx-auto"
          >
            <Check size={14} className="text-emerald-400 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {lastSaved.suggested_name ?? lastSaved.barcode_text}
              {savedCount > 1 && ` · ${savedCount} this session`}
            </span>
            <span className="text-white/70 shrink-0">Open inbox →</span>
          </Link>
        )}
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

        {/* Assign · SHUTTER · Done — the companion app bottom bar. The shutter is the
            photo path for items with no barcode; barcodes never need it. */}
        <div className="flex items-center justify-between max-w-md mx-auto px-2">
          <button
            type="button"
            onClick={() => setAssignOpen(true)}
            className="inline-flex items-center gap-1.5 bg-black/55 hover:bg-black/70 rounded-full px-4 py-2.5 text-white text-sm font-medium w-24 justify-center"
          >
            <MapPin size={15} /> Assign
          </button>
          <button
            type="button"
            onClick={() => void takePhoto()}
            disabled={!running || phase !== "scanning" || shutterBusy}
            aria-label="Take a photo of the item"
            title="Photograph the item (no barcode needed)"
            className="w-[72px] h-[72px] rounded-full bg-white/95 hover:bg-white disabled:opacity-40 flex items-center justify-center shadow-lg"
          >
            <span className="w-[60px] h-[60px] rounded-full border-[3px] border-slate-900/80 flex items-center justify-center">
              {shutterBusy ? (
                <Loader2 size={24} className="text-slate-900 animate-spin" />
              ) : (
                <Camera size={26} className="text-slate-900" />
              )}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              // Done with saves → review exactly this walk-around (the inbox
              // scoped to the session's batch). Nothing saved → just close.
              if (savedCount > 0 && batchIdRef.current) {
                navigate(`/scan?batch=${batchIdRef.current}`);
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
      {assignOpen && (
        <Modal open onClose={() => setAssignOpen(false)} title="Scan area" size="sm">
          <div className="space-y-3">
            <p className="text-xs text-muted dark:text-slate-400">
              Stamped on everything you scan or photograph this session, so triage
              knows where it lives.
            </p>
            <LocationPicker value={areaId} onChange={setAreaId} label="Area" />
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

      {phase === "result" && pendingBarcode && (
        <ScanResultModal
          barcode={pendingBarcode}
          scanArea={areaName}
          scanAreaId={areaId}
          ensureBatchId={ensureBatchId}
          scanTarget={{
            into: params.get("into"),
            module: params.get("module"),
            kind: params.get("kind"),
            label: params.get("label"),
          }}
          onSaved={onSaved}
          onClose={rearm}
        />
      )}
    </div>,
    document.body,
  );
}
