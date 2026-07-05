// A reusable full-screen in-app photo-capture drawer. One capture UX for every
// "take a photo of this" surface (scanner result "Nice photo" / "Not it —
// photograph it", inbox "Retake for catalog" / add photo), so none of them
// launches the iOS native camera on top of the app.
//
//   - Pass `stream` to REUSE an already-running camera (the scanner already holds
//     one — two <video>s can share one MediaStream, so no second getUserMedia and
//     no fight with the paused viewfinder behind a modal).
//   - Omit `stream` and the sheet acquires its OWN rear camera (and stops it on
//     close). If no camera is available / permission denied, it falls back to a
//     plain photo picker.
//
// The sheet only CAPTURES; it hands the caller a Blob via `onCapture` and the
// caller owns the upload + mutation (and closes the sheet on success via `open`).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Check, RotateCcw, X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { acquireScannerStream } from "../lib/barcodeScanner";

export function CameraCaptureSheet({
  open,
  title = "Take a photo",
  stream,
  busy,
  onCapture,
  onClose,
}: {
  open: boolean;
  title?: string;
  /** Reuse an already-running stream (the scanner's). Omitted/null → the sheet
   *  acquires its own rear camera and stops it on close. */
  stream?: MediaStream | null;
  /** Caller's upload/mutation is in flight — disables "Use this". */
  busy?: boolean;
  onCapture: (blob: Blob) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Streams WE acquired (never the borrowed scanner stream) — stopped on close.
  const ownStreamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<"live" | "preview" | "nocam">("live");
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null);

  // Acquire / bind the stream while open; stop any own-acquired stream on close.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMode("live");
    setPreview(null);
    async function start() {
      let s = stream ?? null;
      if (!s) {
        try {
          const res = await acquireScannerStream(null);
          if (cancelled) {
            res.stream.getTracks().forEach((t) => t.stop());
            return;
          }
          s = res.stream;
          ownStreamRef.current = s;
        } catch {
          if (!cancelled) setMode("nocam"); // no camera / denied → photo picker
          return;
        }
      }
      const v = videoRef.current;
      if (v && s) {
        v.srcObject = s;
        void v.play().catch(() => {});
      }
    }
    void start();
    return () => {
      cancelled = true;
      if (ownStreamRef.current) {
        ownStreamRef.current.getTracks().forEach((t) => t.stop());
        ownStreamRef.current = null;
      }
    };
  }, [open, stream]);

  // Re-bind the live feed when returning from preview → live.
  useEffect(() => {
    if (!open || mode !== "live") return;
    const v = videoRef.current;
    const s = stream ?? ownStreamRef.current;
    if (v && s) {
      v.srcObject = s;
      void v.play().catch(() => {});
    }
  }, [mode, open, stream]);

  function shoot() {
    const v = videoRef.current;
    if (!v || v.readyState < 2) return;
    if (typeof navigator.vibrate === "function") navigator.vibrate(30);
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob(
      (blob) => {
        if (!blob) {
          toast.error("Could not capture a frame — try again");
          return;
        }
        setPreview({ blob, url: URL.createObjectURL(blob) });
        setMode("preview");
      },
      "image/jpeg",
      0.9,
    );
  }
  function retake() {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
    setMode("live");
  }
  function close() {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
    onClose();
  }

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] bg-black flex flex-col" data-testid="camera-capture-sheet">
      <div className="relative flex-1 min-h-0">
        {mode === "preview" && preview ? (
          <img src={preview.url} alt="preview" className="absolute inset-0 w-full h-full object-contain" />
        ) : mode === "nocam" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/80 px-8 text-center">
            <Camera size={32} />
            <p className="text-sm">No camera available here — choose a photo instead.</p>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded-full bg-white/10 border border-white/30 px-4 py-2 text-sm text-white touch-manipulation"
            >
              Choose a photo
            </button>
          </div>
        ) : (
          <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
        )}
        <div
          className="absolute top-0 inset-x-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent text-white"
          style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
        >
          <span className="text-sm font-medium truncate">{mode === "preview" ? "Use this shot?" : title}</span>
          <button
            type="button"
            onClick={close}
            aria-label="Cancel"
            className="shrink-0 inline-flex items-center justify-center min-h-11 min-w-11 -mr-2 rounded-full hover:bg-white/10 touch-manipulation"
          >
            <X size={22} />
          </button>
        </div>
      </div>
      <div
        className="shrink-0 bg-black/90 px-6 pt-4 flex items-center justify-center gap-8"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        {mode === "live" ? (
          <button
            type="button"
            onClick={shoot}
            aria-label="Take photo"
            className="h-16 w-16 rounded-full bg-white ring-4 ring-white/30 active:scale-95 transition touch-manipulation"
          />
        ) : mode === "preview" ? (
          <>
            <button
              type="button"
              onClick={retake}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/40 text-white px-4 py-2.5 text-sm hover:bg-white/10 touch-manipulation"
            >
              <RotateCcw size={16} /> Retake
            </button>
            <button
              type="button"
              disabled={busy || !preview}
              onClick={() => preview && onCapture(preview.blob)}
              className="inline-flex items-center gap-1.5 rounded-full bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-5 py-2.5 text-sm font-medium touch-manipulation"
            >
              <Check size={16} /> {busy ? "Saving…" : "Use this"}
            </button>
          </>
        ) : null}
      </div>
      {/* Fallback picker for the no-camera case (desktop w/o webcam, denied). */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.currentTarget.value = "";
          if (f) onCapture(f);
        }}
      />
    </div>,
    document.body,
  );
}
