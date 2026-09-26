/// <reference path="../../occt-import-js.d.ts" />
import { useEffect, useMemo, useRef, useState } from "react";
import type { PreviewRendererProps } from "@cobblr/platform-web";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fitScale, openPdf, pageSizes, ZOOM_STEPS, type PdfDoc, type PdfLib } from "./pdf-read";

// A PDF, every page, in the app: a knitter reads a pattern on a phone while
// working, and a PDF that only downloads leaves her in a Files app. Pages
// are drawn onto canvases by pdf.js (in its worker), each when it scrolls
// into view, so a 60-page pattern opens at the speed of its first page. A
// canvas runs nothing from the file; eval is off (pdf-read.ts).
export default function PdfRenderer({ blobUrl, bytes, filename }: PreviewRendererProps) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [sizes, setSizes] = useState<Array<{ width: number; height: number }>>([]);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: PdfDoc | null = null;
    void (async () => {
      try {
        const pdfjs = (await import("pdfjs-dist")) as unknown as PdfLib & { GlobalWorkerOptions: { workerSrc: string } };
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        opened = await openPdf(bytes, pdfjs);
        const s = await pageSizes(opened);
        if (cancelled) return;
        setDoc(opened);
        setSizes(s);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      void opened?.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const base = useMemo(() => fitScale(sizes[0]?.width ?? 0, Math.max(0, width - 16)), [sizes, width]);
  const step = (dir: 1 | -1) => {
    const i = ZOOM_STEPS.findIndex((z) => z >= zoom);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? ZOOM_STEPS.length - 1 : i) + dir))];
    if (next) setZoom(next);
  };

  if (failed) return <div className="text-xs text-faint italic">This PDF could not be read. Download it to open it elsewhere.</div>;
  return (
    <div className="flex flex-col gap-2" data-testid="pdf-viewer">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{doc ? `${doc.numPages} page${doc.numPages === 1 ? "" : "s"}` : "Opening…"}</span>
        <span className="flex-1" />
        <button type="button" className="rounded border border-line px-2 py-1 hover:text-content" onClick={() => step(-1)} aria-label="Zoom out">−</button>
        <button type="button" className="rounded border border-line px-2 py-1 hover:text-content" onClick={() => setZoom(1)}>Fit</button>
        <button type="button" className="rounded border border-line px-2 py-1 hover:text-content" onClick={() => step(1)} aria-label="Zoom in">+</button>
        <KeepScreenOn />
        <a className="rounded border border-line px-2 py-1 hover:text-content" href={blobUrl} download={filename}>
          Download
        </a>
      </div>
      <div
        ref={box}
        className="max-h-[75vh] overflow-auto rounded border border-line bg-subtle dark:bg-slate-800 p-2"
        style={{ touchAction: "pan-x pan-y pinch-zoom" }}
      >
        {doc &&
          sizes.map((s, i) => (
            <PdfCanvasPage key={i} doc={doc} number={i + 1} width={s.width * base * zoom} height={s.height * base * zoom} scale={base * zoom} />
          ))}
      </div>
    </div>
  );
}

function PdfCanvasPage({ doc, number, width, height, scale }: { doc: PdfDoc; number: number; width: number; height: number; scale: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !canvas.current || !(scale > 0)) return;
    let cancelled = false;
    void (async () => {
      const page = await doc.getPage(number);
      const el = canvas.current;
      if (cancelled || !el) return;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * dpr });
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      const ctx = el.getContext("2d");
      if (ctx) await page.render({ canvasContext: ctx, viewport, canvas: el }).promise.catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, doc, number, scale]);
  return (
    <canvas
      ref={canvas}
      aria-label={`Page ${number}`}
      className="block mx-auto mb-2 bg-white dark:bg-white shadow-sm"
      style={{ width: `${Math.round(width)}px`, height: `${Math.round(height)}px` }}
    />
  );
}

/** "Keep screen on" while a pattern is open, where the browser can. */
function KeepScreenOn() {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }) : null;
  const [lock, setLock] = useState<{ release(): Promise<void> } | null>(null);
  useEffect(() => () => void lock?.release(), [lock]);
  if (!nav?.wakeLock) return null;
  return (
    <button
      type="button"
      aria-pressed={!!lock}
      className={"rounded border px-2 py-1 " + (lock ? "border-accent text-accent" : "border-line hover:text-content")}
      onClick={async () => {
        if (lock) {
          await lock.release().catch(() => {});
          setLock(null);
        } else {
          setLock(await nav.wakeLock!.request("screen").catch(() => null));
        }
      }}
    >
      Keep screen on
    </button>
  );
}
