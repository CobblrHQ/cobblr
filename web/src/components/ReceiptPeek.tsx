// A receipt you can SEE before you act on it.
//
// The "receipts to confirm as purchase orders" panel listed each one as a line
// of text - "Receipt from Walmart, 7 items" - with a Confirm beside it, and no
// way to look at the paper the line was made from. The inbox already opens the
// original from a session's receipt icon; this is the same document, reachable
// from the row that asks you to commit to it (asked 2026-09-06).
//
// Hover shows the thumbnail; the click opens the full viewer the caller owns.
// The thumbnail is an authed core-files reference fetched to a blob: URL, the
// same way every other image on the page is, so a plain <img src> - which
// carries no bearer - is never used.
import { useState, type ReactNode } from "react";
import { useImageSrc } from "@cobblr/platform-web";
import { api } from "../lib/api";

export function ReceiptPeek({
  slug,
  fileId,
  onOpen,
  children,
  title,
  "aria-label": ariaLabel,
  className,
}: {
  slug: string;
  /** The receipt's stored original. Null when there is none (an emailed
   *  receipt with no attachment) - then there is nothing to peek at and the
   *  children render plain. */
  fileId: string | null;
  onOpen: (fileId: string) => void;
  children: ReactNode;
  /** Trigger text, for a bare icon. */
  title?: string;
  "aria-label"?: string;
  className?: string;
}) {
  const [hover, setHover] = useState(false);
  // Fetched on hover only: the panel can list a dozen receipts, and a dozen
  // authed image fetches on mount for pictures nobody asked to see is the
  // wrong default.
  const src = useImageSrc(hover && fileId ? api.fileRawUrl(slug, fileId, "thumb") : null);
  if (!fileId) return <>{children}</>;
  return (
    <span
      className="relative inline-flex min-w-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(fileId);
        }}
        title={title ?? "Open the receipt"}
        aria-label={ariaLabel}
        className={className ?? "min-w-0 text-left hover:text-accent underline-offset-2 hover:underline"}
      >
        {children}
      </button>
      {hover && src && (
        <span
          role="img"
          aria-label="Receipt preview"
          className="pointer-events-none absolute left-0 top-full z-30 mt-1 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-1 shadow-lg"
        >
          <img src={src} alt="" className="block max-h-56 w-auto max-w-[14rem] rounded" />
        </span>
      )}
    </span>
  );
}
