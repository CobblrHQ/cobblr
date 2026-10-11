// A station's own camera, for a tablet with no scanner (#5353). The owner's
// kitchen station is an old Fire tablet on the wall: "use the front facing
// camera, and I could hold up a barcode to the camera and tap the 'used up'
// button". The viewfinder sits on the Ready screen and hands each code it
// reads to the station exactly as a scanner's would; the station's own view
// changes on a read, which closes the camera until it is Ready again.
//
// Same camera and decode as the Scan page and ScanOneSheet (barcodeScanner.ts,
// barcodeDecode.ts). The lens is the device's own: the station's setting
// starts it, the flip button changes it on this device only.

import { useEffect, useRef, useState } from "react";
import { SwitchCamera } from "lucide-react";
import type { StationLens } from "@cobblr/platform-contract/station-screen";
import { acquireScannerStream, NoCameraHere, SCAN_ATTEMPT_DELAY_MS } from "../lib/barcodeScanner";

const LENS_KEY = (slug: string, address: string) => `cobblr.station.lens.${slug}/${address}`;

/** How long the camera stops reading after a key, so a USB or Bluetooth
 *  scanner's burst has the page to itself: a decode on the main thread
 *  between its keys slowed them past the scanner detector's limit, and the
 *  scan was lost (the #5353 kitchen walk, 2026-10-11). Longer than the
 *  detector's 500 ms gap, so a whole burst fits. */
export const CAMERA_QUIET_AFTER_KEY_MS = 800;
/** The widest frame the camera decodes: a barcode held up to a tablet reads
 *  at this size, and a 1920 px frame every 40 ms is what starved the page. */
export const CAMERA_DECODE_MAX_WIDTH = 1280;

/** This device's own pick of lens for a station, or null. */
export function deviceLens(slug: string, address: string): StationLens | null {
  try {
    const v = localStorage.getItem(LENS_KEY(slug, address));
    return v === "front" || v === "rear" ? v : null;
  } catch {
    return null;
  }
}

export function rememberDeviceLens(slug: string, address: string, lens: StationLens): void {
  try {
    localStorage.setItem(LENS_KEY(slug, address), lens);
  } catch {
    // A browser that keeps nothing asks again next time; the lens still opens.
  }
}

export function StationCamera({ lens, onCode, onFlip }: { lens: StationLens; onCode: (code: string) => void; onFlip: () => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onCode);
  done.current = onCode;

  useEffect(() => {
    setError(null);
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    const frame = document.createElement("canvas");
    const rotated = document.createElement("canvas");
    let quietUntil = 0;
    const onKey = () => {
      quietUntil = performance.now() + CAMERA_QUIET_AFTER_KEY_MS;
    };
    document.addEventListener("keydown", onKey, true);
    void (async () => {
      try {
        const [{ createBarcodeReader, decodeCanvasSmart }, acquired] = await Promise.all([import("../lib/barcodeDecode"), acquireScannerStream(null, lens)]);
        const reader = createBarcodeReader();
        stream = acquired.stream;
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const v = video.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
        const tick = () => {
          if (stopped) return;
          if (performance.now() >= quietUntil && v.readyState >= 2 && v.videoWidth) {
            const scale = Math.min(1, CAMERA_DECODE_MAX_WIDTH / v.videoWidth);
            frame.width = Math.round(v.videoWidth * scale);
            frame.height = Math.round(v.videoHeight * scale);
            const ctx = frame.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(v, 0, 0, frame.width, frame.height);
              const text = decodeCanvasSmart(reader, frame, rotated).text;
              if (text) {
                stopped = true;
                done.current(text);
                return;
              }
            }
          }
          timer = window.setTimeout(tick, SCAN_ATTEMPT_DELAY_MS);
        };
        tick();
      } catch (e) {
        // failure-copy: the browser's own camera error (NotAllowed / no camera), caught here.
        setError(
          e instanceof NoCameraHere
            ? e.message
            : e instanceof Error && /denied|NotAllowed/i.test(`${e.name} ${e.message}`)
              ? "The camera is blocked for this site. Allow it in the browser's settings, then reopen the station."
              : "The camera could not start.",
        );
      }
    })();
    return () => {
      stopped = true;
      document.removeEventListener("keydown", onKey, true);
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [lens]);

  return (
    <div className="w-full max-w-md space-y-2" data-testid="station-camera">
      {error ? (
        <p className="rounded-2xl border border-line p-4 text-lg text-ember-600 dark:border-slate-600 dark:text-ember-400" role="alert">
          {error}
        </p>
      ) : (
        <div className="relative overflow-hidden rounded-2xl bg-black">
          {/* The front lens is shown as a mirror, the way a person expects to see themselves holding something up. */}
          <video ref={video} muted playsInline className={`aspect-[4/3] w-full object-cover ${lens === "front" ? "-scale-x-100" : ""}`} />
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-base text-muted">Hold the barcode up to the {lens === "front" ? "front" : "back"} camera.</span>
        <button
          type="button"
          onClick={onFlip}
          className="inline-flex min-h-[48px] shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-line px-4 text-lg text-content hover:border-cobble-400 dark:border-slate-600"
        >
          <SwitchCamera size={20} /> Flip camera
        </button>
      </div>
    </div>
  );
}

/** "Ask": the device picks its lens once, and keeps it. */
export function StationLensChoice({ onPick }: { onPick: (lens: StationLens) => void }) {
  return (
    <div className="flex w-full max-w-md flex-col gap-3" data-testid="station-lens-choice">
      <p className="text-lg text-muted">Which camera faces where you hold things up?</p>
      <div className="flex gap-3">
        <button type="button" onClick={() => onPick("front")} className="min-h-[64px] flex-1 rounded-2xl bg-cobble-600 px-5 text-xl font-semibold text-white hover:bg-cobble-700">
          The front camera
        </button>
        <button type="button" onClick={() => onPick("rear")} className="min-h-[64px] flex-1 rounded-2xl border border-line px-5 text-xl font-semibold text-content hover:border-cobble-400 dark:border-slate-600">
          The back camera
        </button>
      </div>
    </div>
  );
}
