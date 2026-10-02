// The "View original" viewer for a receipt session — shows the exact file the
// lines were parsed from (an uploaded PDF/photo, or the emailed body). Renders
// BY WHAT THE BYTES ARE (shownAs): an <img> for a photo, the app's PDF reader
// for a PDF, a <pre> for text/html (the emailed body), and a Download for
// anything else, which is never dumped as text. An earlier version always used an <iframe>, but the emailed
// body is stored with no file extension so the browser typed the blob as
// octet-stream and DOWNLOADED it instead of rendering (reported 2026-07-24). The
// source is an authed core-files reference fetched to a blob: URL via useImageSrc;
// we then read that blob's first bytes to pick the renderer.

import { useEffect, useRef, useState } from "react";
import { OverlayCloseButton } from "./OverlayCloseButton";
import { createPortal } from "react-dom";

import { useImageSrc, useEscapeToClose, OverlayLayer, FilePreview } from "@cobblr/platform-web";
import { shownAs } from "@cobblr/platform-contract/sniff-type";
import { api } from "../lib/api";
import { centsFromAmount, formatMoney } from "@cobblr/platform-contract/money";

/** The name the PDF reader is handed: the file's own when it ends in .pdf,
 *  else the same with .pdf, since the bytes already said it is one. */
function filenameAsPdf(name: string | null | undefined): string {
  const n = (name ?? "").trim() || "document";
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
}

type Rendered =
  | { kind: "loading" }
  | { kind: "image"; url: string }
  | { kind: "pdf" }
  | { kind: "text"; text: string }
  | { kind: "binary"; url: string };

/** What a receipt SAID about money, as the parser read it. Every part is
 *  optional: a till slip with no tax line has no tax, and showing a 0 we
 *  invented would be a claim the document never made. */
export interface ReceiptMoney {
  currency?: string;
  /** The sum before anything came off - the receipt's own subtotal. */
  list_price?: number;
  /** What came off: coupons, member savings, markdowns. */
  discounts?: number;
  /** Subtotal minus discounts, when the receipt's numbers agreed. */
  net_price?: number;
  tax?: number;
  shipping?: number;
  /** What the card was actually charged. */
  total_charged?: number;
}

/** The money line, laid out for reading. Exported so it can be tested without
 *  a viewer, a blob URL or a document renderer. */
export function receiptMoneyRows(m: ReceiptMoney | null | undefined): Array<{ label: string; value: number }> {
  if (!m) return [];
  const rows: Array<{ label: string; value: number }> = [];
  const add = (label: string, v: number | undefined) => {
    if (typeof v === "number" && Number.isFinite(v)) rows.push({ label, value: v });
  };
  add("Subtotal", m.list_price);
  // Shown as what it IS - money off - rather than a negative to decode.
  add("Savings", m.discounts);
  // Only when it says something the two numbers above do not already.
  if (
    typeof m.net_price === "number" &&
    !(typeof m.list_price === "number" && typeof m.discounts === "number")
  ) {
    add("After savings", m.net_price);
  }
  add("Tax", m.tax);
  add("Shipping", m.shipping);
  add("Total", m.total_charged);
  return rows;
}

/** A receipt's figure in the receipt's own currency. */
function money(v: number, currency?: string): string {
  return formatMoney(centsFromAmount(v), { currency });
}

export function ReceiptSourceViewer({
  slug,
  fileId,
  onClose,
  money: receiptMoney,
  soldBy,
  filename,
}: {
  slug: string;
  fileId: string;
  onClose: () => void;
  /** What the receipt said it cost. The parser has kept these since receipts
   *  shipped and nothing ever showed them, so "what did this actually cost me"
   *  had no answer on any screen (2026-08-25 audit). Here, beside the document
   *  they were read from, is where they can be checked against it. */
  money?: ReceiptMoney | null;
  /** The marketplace seller, when the receipt named one distinct from the shop. */
  soldBy?: string | null;
  /** The file's name, for the PDF reader and a download. */
  filename?: string | null;
}) {
  // Authed fetch → blob: URL (same Bearer path the image lightbox uses).
  const blobUrl = useImageSrc(api.fileRawUrl(slug, fileId, "original"));
  const [rendered, setRendered] = useState<Rendered>({ kind: "loading" });

  const layerRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(true, layerRef, onClose);

  useEffect(() => {
    if (!blobUrl) return;
    let cancelled = false;
    // Read the blob's real content-type (a blob: URL is same-origin, no auth) and
    // pick a renderer — an <iframe> on an octet-stream/text blob just downloads it.
    void (async () => {
      try {
        const blob = await (await fetch(blobUrl)).blob();
        const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
        if (cancelled) return;
        // By what the file IS (its bytes), never the type it was served
        // with: a PDF is served as a download, and reading it as text showed
        // a scanned bill of sale as its raw bytes (#4523).
        const as = shownAs(head, blob.type);
        if (as === "image") setRendered({ kind: "image", url: blobUrl });
        else if (as === "pdf") setRendered({ kind: "pdf" });
        else if (as === "binary") setRendered({ kind: "binary", url: blobUrl });
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
    <OverlayLayer
      ref={layerRef}
      className="z-[130] bg-black/85 backdrop-blur-sm flex flex-col"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={filename ? `Original: ${filename}` : "Original receipt"}
    >
      <OverlayCloseButton onClose={onClose} />
      {/* What the document is, by name ("Email from eBay, Aug 12"): the
          caller names it, never a file name the platform made up (#4581). */}
      {filename && (
        <div data-testid="receipt-viewer-name" onClick={(e) => e.stopPropagation()} className="absolute left-4 sm:left-6 right-16 top-4 truncate text-sm font-medium text-white">
          {filename}
        </div>
      )}
      {(() => {
        const rows = receiptMoneyRows(receiptMoney);
        if (rows.length === 0 && !soldBy) return null;
        return (
          <div
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 mx-4 sm:mx-6 mt-14 rounded-lg bg-white/10 px-3 py-2 text-[12px] text-white/90"
          >
            {soldBy && (
              <div className="mb-1 text-white/70">
                sold by <span className="text-white">{soldBy}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {rows.map((r) => (
                <span key={r.label} className={r.label === "Total" ? "font-medium" : "text-white/70"}>
                  {r.label} {money(r.value, receiptMoney?.currency)}
                </span>
              ))}
            </div>
          </div>
        );
      })()}
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
          // photo-frame: the original receipt, read in full at its own shape in a viewer
          // lightbox-exempt: one receipt read as a document (an image, a PDF or text), beside the amounts read from it
          <img
            src={rendered.url}
            alt="Original receipt"
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded shadow-2xl"
          />
        )}
        {rendered.kind === "pdf" && (
          // The app's own PDF reader (every page, drawn by pdf.js), so a PDF
          // reads the same here as on a record. Pushed below the close
          // button, which otherwise sits on the reader's toolbar.
          <div onClick={(e) => e.stopPropagation()} className="mt-10 w-full max-w-3xl max-h-[calc(100%-2.5rem)] overflow-auto rounded" data-testid="receipt-pdf">
            <FilePreview src={api.fileRawUrl(slug, fileId, "original")} filename={filenameAsPdf(filename)} className="w-full" />
          </div>
        )}
        {rendered.kind === "binary" && (
          <div onClick={(e) => e.stopPropagation()} className="rounded bg-surface text-content p-6 text-sm text-center space-y-3" data-testid="receipt-binary">
            <p>This file can&apos;t be shown as text.</p>
            <a href={rendered.url} download={filename || "file"} className="inline-block rounded bg-cobble-600 hover:bg-cobble-700 px-3 py-1.5 text-white">
              Download
            </a>
          </div>
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
    </OverlayLayer>,
    document.body,
  );
}
