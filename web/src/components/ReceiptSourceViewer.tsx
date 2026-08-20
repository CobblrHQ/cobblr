// The "View original" viewer for a receipt session — shows the exact file the
// lines were parsed from (an uploaded PDF/photo, or the emailed body). Renders
// BY TYPE: an <img> for a photo, an <iframe> for a PDF, and a <pre> for text/html
// (the emailed body). An earlier version always used an <iframe>, but the emailed
// body is stored with no file extension so the browser typed the blob as
// octet-stream and DOWNLOADED it instead of rendering (reported 2026-07-24). The
// source is an authed core-files reference fetched to a blob: URL via useImageSrc;
// we then read that blob's content-type to pick the renderer.

import { useEffect, useState } from "react";
import { OverlayCloseButton } from "./OverlayCloseButton";
import { createPortal } from "react-dom";

import { useImageSrc, OverlayFlag } from "@cobblr/platform-web";
import { api } from "../lib/api";

type Rendered =
  | { kind: "loading" }
  | { kind: "image"; url: string }
  | { kind: "pdf"; url: string }
  | { kind: "text"; text: string };

export function ReceiptSourceViewer({
  slug,
  fileId,
  onClose,
}: {
  slug: string;
  fileId: string;
  onClose: () => void;
}) {
  // Authed fetch → blob: URL (same Bearer path the image lightbox uses).
  const blobUrl = useImageSrc(api.fileRawUrl(slug, fileId, "original"));
  const [rendered, setRendered] = useState<Rendered>({ kind: "loading" });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!blobUrl) return;
    let cancelled = false;
    // Read the blob's real content-type (a blob: URL is same-origin, no auth) and
    // pick a renderer — an <iframe> on an octet-stream/text blob just downloads it.
    void (async () => {
      try {
        const blob = await (await fetch(blobUrl)).blob();
        const type = blob.type || "";
        if (cancelled) return;
        if (type.startsWith("image/")) setRendered({ kind: "image", url: blobUrl });
        else if (type === "application/pdf") setRendered({ kind: "pdf", url: blobUrl });
        else setRendered({ kind: "text", text: await blob.text() });
      } catch {
        if (!cancelled) setRendered({ kind: "text", text: "Couldn't load the original." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blobUrl]);

  return createPortal(
    <div
      className="fixed inset-0 z-[130] bg-black/85 backdrop-blur-sm flex flex-col"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Original receipt"
    >
      <OverlayFlag />
      <OverlayCloseButton onClose={onClose} />
      {/* The dark surround closes; the DOCUMENT does not. This block used to
          swallow the click itself, and it is flex-1 over the full width, so
          "outside the receipt" was inside it and nothing but the X ever closed
          the viewer (reported 2026-08-19). Each rendered document stops the
          click on its own, which is the only part that should. */}
      <div className="flex-1 min-h-0 p-4 sm:p-6 flex items-center justify-center">
        {rendered.kind === "loading" && (
          <div className="text-white/50 text-sm">Loading…</div>
        )}
        {rendered.kind === "image" && (
          <img
            src={rendered.url}
            alt="Original receipt"
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded shadow-2xl"
          />
        )}
        {rendered.kind === "pdf" && (
          <iframe
            src={rendered.url}
            title="Original receipt"
            onClick={(e) => e.stopPropagation()}
            className="w-full h-full rounded bg-white"
          />
        )}
        {rendered.kind === "text" && (
          <pre
            onClick={(e) => e.stopPropagation()}
            className="w-full h-full overflow-auto rounded bg-white text-slate-800 text-xs leading-relaxed p-4 whitespace-pre-wrap break-words"
          >
            {rendered.text}
          </pre>
        )}
      </div>
    </div>,
    document.body,
  );
}
