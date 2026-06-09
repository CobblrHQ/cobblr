// /scan/camera — mobile-first camera capture, companion app-grade.
//
// Two things make this feel fast on an iPhone (see lib/barcodeScanner):
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

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Camera, Check, Flashlight, ScanLine, X } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { type ScanInboxItem } from "../lib/api";
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

export function ScanCameraPage() {
  usePageTitle("Scan camera");
  // Preserve the instance-scan target (?into=…) so the modal + return keep it.
  const [params] = useSearchParams();
  const backToScan = `/scan${params.toString() ? `?${params}` : ""}`;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const detectorRef = useRef<InstanceType<BarcodeDetectorCtor> | null>(null);
  const lastSeenRef = useRef<{ value: string; at: number } | null>(null);
  // phaseRef mirrors `phase` so the decode callbacks (set up once) read the
  // live value — once we're in the result modal, decodes are ignored. That
  // guard IS the "stop scanning the same thing over and over" fix.
  const phaseRef = useRef<Phase>("idle");

  const [phase, setPhaseState] = useState<Phase>("idle");
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

  useEffect(() => {
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
      .BarcodeDetector;
    setSupported(!!Detector);
  }, []);

  // A decoded value → block into the result modal (dedup a stale repeat first).
  const onDetect = useCallback(
    (rawIn: string) => {
      if (phaseRef.current !== "scanning") return;
      const raw = rawIn.trim();
      if (!raw) return;
      const last = lastSeenRef.current;
      if (last && last.value === raw && Date.now() - last.at < 2_000) return;
      lastSeenRef.current = { value: raw, at: Date.now() };
      if (typeof navigator.vibrate === "function") navigator.vibrate(70);
      setPendingBarcode(raw);
      setPhase("result");
    },
    [setPhase],
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

  // Modal closed → re-arm the scanner (or back to idle if the camera stopped).
  const rearm = useCallback(() => {
    setPendingBarcode(null);
    setPhase(streamRef.current ? "scanning" : "idle");
  }, [setPhase]);

  const onSaved = useCallback((item: ScanInboxItem) => {
    setRecent((prev) => [item, ...prev.filter((p) => p.id !== item.id)].slice(0, 8));
  }, []);

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <Link
          to={backToScan}
          className="text-sm text-muted hover:text-accent inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Back to inbox
        </Link>
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
          <Camera size={20} className="text-accent" /> Camera scan
        </h1>
      </div>

      {supported === false && (
        <div className="rounded-md border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 p-3 text-xs text-muted dark:text-slate-400">
          Hold the barcode steady in the frame. You can also type the UPC below.
        </div>
      )}

      <div className="rounded-xl overflow-hidden border border-line dark:border-slate-700 bg-black aspect-[3/4] relative">
        <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
        {!running && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/85 text-white">
            <button
              type="button"
              onClick={() => setPhase("scanning")}
              className="inline-flex items-center gap-2 rounded-full bg-cobble-600 hover:bg-cobble-700 px-4 py-2 text-sm font-medium"
            >
              <Camera size={16} /> Start camera
            </button>
          </div>
        )}
        {running && (
          <div className="absolute top-3 right-3 flex items-center gap-2 text-white text-xs">
            <span className="inline-flex items-center gap-1 bg-black/50 rounded-full px-2 py-1">
              <span
                className={`w-2 h-2 rounded-full ${phase === "scanning" ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`}
              />
              {phase === "scanning" ? "live" : "paused"}
            </span>
            <button
              type="button"
              onClick={() => setPhase("idle")}
              className="bg-black/50 rounded-full p-1 hover:bg-black/70"
              title="Stop"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {running && hasTorch && (
          <button
            type="button"
            onClick={toggleTorch}
            className={`absolute top-3 left-3 rounded-full p-2 ${torchOn ? "bg-amber-400 text-slate-900" : "bg-black/50 text-white hover:bg-black/70"}`}
            title="Torch"
          >
            <Flashlight size={15} />
          </button>
        )}
        {phase === "scanning" && (
          <div className="absolute inset-x-6 top-1/2 -translate-y-1/2 border-2 border-accent/80 rounded-md h-32 pointer-events-none" />
        )}
      </div>

      {error && <div className="text-sm text-ember-500">Camera error: {error}</div>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = manual.trim();
          if (!v) return;
          setManual("");
          setPendingBarcode(v);
          setPhase("result");
        }}
        className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 flex gap-2 items-center"
      >
        <ScanLine size={16} className="text-faint" />
        <input
          type="text"
          inputMode="numeric"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Or type the UPC manually"
          className="flex-1 px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 font-mono"
        />
        <button
          type="submit"
          disabled={!manual.trim()}
          className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          Scan
        </button>
      </form>

      {recent.length > 0 && (
        <section>
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
            // this session ({recent.length})
          </div>
          <ul className="space-y-1.5">
            {recent.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2 text-sm"
              >
                <Check size={14} className="text-moss-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-content dark:text-mortar-100 truncate">
                    {item.suggested_name ?? <span className="text-faint italic">no catalog hit</span>}
                  </div>
                  <div className="text-[10px] font-mono text-faint truncate">
                    {item.barcode_text}
                    {item.quantity > 1 && ` · ×${item.quantity}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <Link
            to={backToScan}
            className="block text-center text-xs text-accent hover:text-accent mt-3"
          >
            Open inbox to confirm →
          </Link>
        </section>
      )}

      {phase === "result" && pendingBarcode && (
        <ScanResultModal
          barcode={pendingBarcode}
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
    </div>
  );
}
