// A document's tile: its first page when it has one that can be drawn (a
// PDF), else a document icon with its file name. Never a blank tile.
//
// Drawn in the browser from the stored file at view time (the format's
// thumbnail drawer, registered by core-file-preview), once per file per page
// load: nothing is stored, and every door a document arrives by gets one. The
// file's type is read from its bytes (sniffType), not from its name or the
// type it was stored with, so a PDF stored under a wrong type still shows its
// page. The one tile for a document everywhere: the inbox's document
// sessions, a record's Files, attachments.
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { sniffType } from "@cobblr/platform-contract/sniff-type";
import { thumbDrawerFor } from "./filePreview";

const TOKEN_KEY = "cobblr.token";

/** One drawing per file per page load, shared by every tile that shows it. */
const drawn = new Map<string, Promise<string | null>>();

async function draw(src: string, width: number): Promise<string | null> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
  const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  const sniffed = sniffType(new Uint8Array(bytes, 0, Math.min(64, bytes.byteLength)));
  const ext = sniffed === "application/pdf" ? "pdf" : null;
  const loader = ext ? thumbDrawerFor(ext) : undefined;
  if (!loader) return null;
  const { default: drawer } = await loader();
  return drawer(bytes, width).catch(() => null);
}

/** The drawing for one file, started at most once. Exported for a test. */
export function docThumbFor(src: string, width = 160): Promise<string | null> {
  const key = `${src}@${width}`;
  let p = drawn.get(key);
  if (!p) {
    p = draw(src, width).catch(() => null);
    drawn.set(key, p);
  }
  return p;
}

export function DocThumb({
  src,
  filename,
  width = 160,
  className,
  onOpen,
}: {
  /** The authed raw URL of the stored original. */
  src: string;
  filename: string;
  /** CSS width the page is drawn for. */
  width?: number;
  className?: string;
  /** Tapping the tile opens the full viewer. */
  onOpen?: () => void;
}) {
  const [page, setPage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setPage(undefined);
    void docThumbFor(src, width).then((p) => live && setPage(p));
    return () => {
      live = false;
    };
  }, [src, width]);

  const body = page ? (
    // photo-frame: a document's first page, drawn from the file, shown whole.
    // The page stays white in dark mode: it is the paper.
    <img src={page} alt={`First page of ${filename}`} className="w-full h-full object-contain bg-white dark:bg-white" />
  ) : (
    <div className="w-full h-full flex flex-col items-center justify-center gap-1 p-2 text-center bg-mortar-50/60 dark:bg-slate-800">
      <FileText size={22} className={page === undefined ? "text-faint animate-pulse" : "text-muted"} aria-hidden />
      <span className="text-[11px] leading-tight text-muted break-all line-clamp-3">{filename}</span>
    </div>
  );
  return onOpen ? (
    <button type="button" onClick={onOpen} aria-label={`Open ${filename}`} title={`Open ${filename}`} className={`block overflow-hidden ${className ?? ""}`}>
      {body}
    </button>
  ) : (
    <div title={filename} className={`overflow-hidden ${className ?? ""}`}>
      {body}
    </div>
  );
}
