// CropPhotoModal: drag a box across your own photo and that box becomes the
// item's catalog image.
//
// The route has cropped the identify photo since 2026-08-11 (`crop` on
// POST /inbox/:id/catalog-image) and the client call shipped beside it, but
// nothing on screen ever called it: "use as catalog" took the whole frame,
// and a photo of a tea tin on a cluttered counter became a catalog image of
// the counter (2026-09-08: "use this as the catalog photo but then I need to
// be able to crop it"). This is the door. lint:api-client-reachable now
// refuses a client method with no caller, so the next one cannot sit unused.
//
// The box is fractions of the image (cropBox.ts), so the preview can be any
// size: the server crops the ORIGINAL at full resolution.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { OverlayFlag } from "@cobblr/platform-web";
import { OverlayCloseButton } from "./OverlayCloseButton";
import { cropBoxFrom, type CropBox, type Point } from "./cropBox";

export function CropPhotoModal({
  src,
  busy,
  onCrop,
  onClose,
}: {
  /** The photo, already resolved to something an <img> can show. */
  src: string | null;
  busy?: boolean;
  onCrop: (box: CropBox) => void;
  onClose: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState<{ start: Point; cur: Point } | null>(null);
  const [box, setBox] = useState<CropBox | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rectOf = () => imgRef.current?.getBoundingClientRect() ?? null;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = { x: e.clientX, y: e.clientY };
    setDrag({ start: p, cur: p });
    setBox(null);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag({ start: drag.start, cur: { x: e.clientX, y: e.clientY } });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const rect = rectOf();
    setBox(rect ? cropBoxFrom(drag.start, { x: e.clientX, y: e.clientY }, rect) : null);
    setDrag(null);
  };

  // The live rectangle while dragging, as fractions of the image, so it is
  // drawn with the same maths the sent box uses.
  const live: CropBox | null = (() => {
    if (box) return box;
    if (!drag) return null;
    const rect = rectOf();
    if (!rect) return null;
    const r = cropBoxFrom(drag.start, drag.cur, rect);
    if (r) return r;
    const x = (Math.min(drag.start.x, drag.cur.x) - rect.left) / rect.width;
    const y = (Math.min(drag.start.y, drag.cur.y) - rect.top) / rect.height;
    return { x, y, w: 0, h: 0 };
  })();

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-[130] bg-black/85 backdrop-blur-sm flex flex-col"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Crop your photo for the catalog image"
    >
      <OverlayFlag />
      <OverlayCloseButton onClose={onClose} />

      <div className="flex-1 min-h-0 flex items-center justify-center p-4 sm:p-6" onClick={stop}>
        {src ? (
          <div
            data-testid="crop-surface"
            className="relative inline-block touch-none select-none cursor-crosshair"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(null)}
          >
            <img
              ref={imgRef}
              src={src}
              alt="your photo"
              draggable={false}
              className="block max-w-full max-h-[70vh] object-contain rounded shadow-2xl"
            />
            {live && (
              <div
                data-testid="crop-box"
                className="absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] pointer-events-none rounded-sm"
                style={{
                  left: `${live.x * 100}%`,
                  top: `${live.y * 100}%`,
                  width: `${live.w * 100}%`,
                  height: `${live.h * 100}%`,
                }}
              />
            )}
          </div>
        ) : (
          <div className="text-white/70 text-sm">Loading your photo…</div>
        )}
      </div>

      <div
        className="shrink-0 w-full max-w-3xl mx-auto p-4 space-y-2"
        style={{ paddingBottom: "max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))" }}
        onClick={stop}
      >
        <p className="text-[11px] text-white/60 text-center">
          {box ? "Drag again to pick a different part." : "Drag across the part of the photo to keep."}
        </p>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-md border border-white/30 text-white/80 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!box || busy}
            onClick={() => box && onCrop(box)}
            className="px-3 py-1.5 text-xs rounded-md bg-accent text-white disabled:opacity-40"
          >
            {busy ? "Cropping…" : "Use crop as catalog image"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
