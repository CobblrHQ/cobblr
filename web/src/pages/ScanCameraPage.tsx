// /scan/camera — mobile-first camera capture page.
//
// Opens the back-facing camera in a <video> element and uses the
// browser's BarcodeDetector API (Chromium-on-Android: solid;
// iOS Safari 17+: shipped; older: not present — falls back to a
// manual-entry input). On a hit we POST /scan + flash the result.
//
// Stays on the page after a successful scan so a user walking
// around can fire 5-10 scans in a row without leaving. Each one
// shows up as a green toast + appends to a "this session" list.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, Camera, Check, ScanLine, X } from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, type ScanInboxItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

// BarcodeDetector type — not in lib.dom.d.ts as of TS 5.7. Local
// shim so we can call it without DOM typings yelling.
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): {
    detect: (source: HTMLVideoElement | ImageBitmap | HTMLCanvasElement) =>
      Promise<Array<{ rawValue: string; format?: string }>>;
  };
  getSupportedFormats(): Promise<string[]>;
}

const SUPPORTED_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "qr_code",
];

export function ScanCameraPage() {
  usePageTitle("Scan camera");
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<InstanceType<BarcodeDetectorCtor> | null>(null);
  const lastSeenRef = useRef<{ value: string; at: number } | null>(null);

  const [supported, setSupported] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<ScanInboxItem[]>([]);
  const [manual, setManual] = useState("");

  const scan = useMutation({
    mutationFn: (value: string) =>
      api.scanBarcode(activeSlug, { barcode: value.trim() }),
    onSuccess: (item) => {
      setRecent((prev) => [item, ...prev].slice(0, 8));
      toast.success(
        item.suggested_name
          ? `Found: ${item.suggested_name}`
          : `Scanned ${item.barcode_text} (no catalog hit)`,
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Feature-detect once.
  useEffect(() => {
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
      .BarcodeDetector;
    setSupported(!!Detector);
  }, []);

  // Start / stop the camera + detection loop based on `running`.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let raf: number | null = null;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        streamRef.current = stream;
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
          .BarcodeDetector;
        if (Detector) {
          detectorRef.current = new Detector({ formats: SUPPORTED_FORMATS });
          loop();
        }
      } catch (err) {
        setError((err as Error).message);
        setRunning(false);
      }
    }

    function loop() {
      if (cancelled) return;
      const video = videoRef.current;
      const detector = detectorRef.current;
      if (!video || !detector || video.readyState < 2) {
        raf = requestAnimationFrame(loop);
        return;
      }
      detector
        .detect(video)
        .then((results) => {
          if (cancelled || results.length === 0) return;
          const raw = results[0]!.rawValue.trim();
          // Dedupe: ignore the same code twice within 3 seconds.
          const last = lastSeenRef.current;
          if (last && last.value === raw && Date.now() - last.at < 3_000) return;
          lastSeenRef.current = { value: raw, at: Date.now() };
          // Haptic feedback if available — mobile users like the buzz.
          if (typeof navigator.vibrate === "function") {
            navigator.vibrate(80);
          }
          scan.mutate(raw);
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
    };
  }, [running, scan]);

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <Link
          to="/scan"
          className="text-sm text-muted hover:text-accent inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Back to inbox
        </Link>
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
          <Camera size={20} className="text-accent" /> Camera scan
        </h1>
      </div>

      {supported === false && (
        <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-700 dark:text-amber-200">
          This browser doesn't support the BarcodeDetector API. Use Chrome
          on Android, Safari 17+, or fall back to manual entry below.
        </div>
      )}

      <div className="rounded-xl overflow-hidden border border-line dark:border-slate-700 bg-black aspect-[3/4] relative">
        <video
          ref={videoRef}
          playsInline
          muted
          className="w-full h-full object-cover"
        />
        {!running && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/85 text-white">
            <button
              type="button"
              onClick={() => setRunning(true)}
              disabled={supported === false}
              className="inline-flex items-center gap-2 rounded-full bg-cobble-600 hover:bg-cobble-700 px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              <Camera size={16} /> Start camera
            </button>
          </div>
        )}
        {running && (
          <div className="absolute top-3 right-3 flex items-center gap-2 text-white text-xs">
            <span className="inline-flex items-center gap-1 bg-black/50 rounded-full px-2 py-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              live
            </span>
            <button
              type="button"
              onClick={() => setRunning(false)}
              className="bg-black/50 rounded-full p-1 hover:bg-black/70"
              title="Stop"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {running && (
          <div className="absolute inset-x-6 top-1/2 -translate-y-1/2 border-2 border-accent/80 rounded-md h-32 pointer-events-none" />
        )}
      </div>

      {error && (
        <div className="text-sm text-ember-500">Camera error: {error}</div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!manual.trim()) return;
          scan.mutate(manual.trim());
          setManual("");
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
          disabled={!manual.trim() || scan.isPending}
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
                    {item.suggested_name ?? (
                      <span className="text-faint italic">no catalog hit</span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-faint truncate">
                    {item.barcode_text}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <Link
            to="/scan"
            className="block text-center text-xs text-accent hover:text-accent mt-3"
          >
            Open inbox to confirm →
          </Link>
        </section>
      )}
    </div>
  );
}
