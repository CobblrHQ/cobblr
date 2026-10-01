// A camera sheet that reads ONE code and hands it back, for a page that takes
// scanned things (a printer's Loaded panel). A phone has no scanner gun, so
// "scan a spool to load it" needs the camera right there, not the Scan page,
// which would take you away from the printer.
//
// Same camera and decode as the Scan page (barcodeScanner.ts): the plain rear
// lens with continuous autofocus, and our own decode loop with the aimed
// rotate. Closes on the first read.

import { useEffect, useRef, useState } from "react";
import { Modal } from "@cobblr/platform-web";
import { acquireScannerStream, createBarcodeReader, decodeCanvasSmart, SCAN_ATTEMPT_DELAY_MS } from "../lib/barcodeScanner";

export function ScanOneSheet({ open, title, hint, onCode, onClose }: { open: boolean; title: string; hint?: string; onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onCode);
  done.current = onCode;

  useEffect(() => {
    if (!open) return;
    setError(null);
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    const reader = createBarcodeReader();
    const frame = document.createElement("canvas");
    const rotated = document.createElement("canvas");
    void (async () => {
      try {
        stream = (await acquireScannerStream()).stream;
        if (stopped) return;
        const v = video.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
        const tick = () => {
          if (stopped) return;
          if (v.readyState >= 2 && v.videoWidth) {
            frame.width = v.videoWidth;
            frame.height = v.videoHeight;
            const ctx = frame.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(v, 0, 0);
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
        setError(e instanceof Error && /denied|NotAllowed/i.test(`${e.name} ${e.message}`) ? "The camera is blocked for this site. Allow it in the browser's settings." : "The camera could not start.");
      }
    })();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <div className="space-y-2" data-testid="scan-one-sheet">
        {error ? (
          <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>
        ) : (
          <video ref={video} muted playsInline className="w-full aspect-[4/3] rounded-lg bg-black object-cover" />
        )}
        {hint && <p className="text-xs text-muted dark:text-slate-400">{hint}</p>}
      </div>
    </Modal>
  );
}
