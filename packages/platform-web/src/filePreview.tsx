// File-preview renderer registry — the isolation-respecting seam for the
// `core-file-preview` capability (extension-registry.md / module-isolation).
//
// platform-web OWNS the registry + the <FilePreview> reader. Modules PUSH
// renderers in (`registerFilePreviewRenderer`) when their UI bundle loads;
// consumers (digifab job views, attachment panels, the App Player) read
// via <FilePreview> — so NOBODY imports the module. Renderers are keyed by
// file extension and provided as LAZY loaders, so the heavy per-format
// libs (three.js for STL, …) only download when a file of that type is
// actually previewed. A future hot-loaded third-party renderer is just
// another loader that mounts a sandboxed iframe — same registry, same key.

import { sniffType } from "@cobblr/platform-contract/sniff-type";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from "react";

/** Props every format renderer receives — the file already fetched (auth
 *  handled by <FilePreview>) as both a blob: URL (for `<img>`/`<object>`)
 *  and raw bytes (for STL/gcode parsing). */
export interface PreviewRendererProps {
  blobUrl: string;
  bytes: ArrayBuffer;
  filename: string;
}
type RendererLoader = () => Promise<{ default: ComponentType<PreviewRendererProps> }>;

const REGISTRY = new Map<string, RendererLoader>();

// Reactivity: the host gate can register/unregister renderers at runtime
// (e.g. a machine domain is enabled mid-session). Surfaces that decide
// whether to OFFER a preview subscribe via useFilePreviewRegistry() so
// they re-render the moment the set changes.
let version = 0;
const listeners = new Set<() => void>();
function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

/** Register a renderer for one or more file extensions (case-insensitive,
 *  leading dot optional). Called by a module's UI bundle at load. */
export function registerFilePreviewRenderer(exts: string[], loader: RendererLoader): void {
  for (const e of exts) REGISTRY.set(e.toLowerCase().replace(/^\./, ""), loader);
  notify();
}

/** Remove renderers for the given extensions. Lets the host turn a set of
 *  renderers off when the gating condition changes (e.g. a domain that
 *  enabled them was disabled). */
export function unregisterFilePreviewRenderer(exts: string[]): void {
  for (const e of exts) REGISTRY.delete(e.toLowerCase().replace(/^\./, ""));
  notify();
}

/** A thumbnail drawer: a file's bytes to a small picture (a data URL), or
 *  null when it cannot be drawn. Registered by format, as renderers are, so
 *  a document tile (<DocThumb>) shows a PDF's first page without importing
 *  the module that knows how to draw one. */
export type ThumbDrawer = (bytes: ArrayBuffer, width: number) => Promise<string | null>;
type ThumbLoader = () => Promise<{ default: ThumbDrawer }>;
const THUMBS = new Map<string, ThumbLoader>();

export function registerFileThumbRenderer(exts: string[], loader: ThumbLoader): void {
  for (const e of exts) THUMBS.set(e.toLowerCase().replace(/^\./, ""), loader);
  notify();
}

/** The thumbnail drawer for a format (by extension, e.g. "pdf"), if any. */
export function thumbDrawerFor(ext: string): ThumbLoader | undefined {
  return THUMBS.get(ext.toLowerCase());
}

/** Subscribe to renderer-set changes — returns a version that bumps on
 *  every register/unregister, so a component re-evaluates canPreviewFile. */
export function useFilePreviewRegistry(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
    () => version,
  );
}

/** The renderer for a type the bytes named, if one is registered. */
function rendererForType(type: string | null): RendererLoader | undefined {
  if (type === "application/pdf") return REGISTRY.get("pdf");
  return undefined;
}

function extOf(filename: string): string {
  return (filename.split(".").pop() ?? "").toLowerCase();
}

/** Is there a registered renderer for this filename's extension? Lets a
 *  surface decide whether to offer a preview at all. */
export function canPreviewFile(filename: string): boolean {
  return REGISTRY.has(extOf(filename));
}

const TOKEN_KEY = "cobblr.token";

/** Render a preview of a stored file. `src` is the authed core-files raw
 *  URL (`/api/v1/orgs/:slug/modules/core-files/files/:id/raw`); we fetch
 *  it with the SPA token, then hand the bytes to the format renderer. No
 *  renderer for the extension → a quiet "no preview" note. */
export function FilePreview({
  src,
  filename,
  className,
}: {
  src: string;
  filename: string;
  className?: string;
}) {
  const ext = extOf(filename);
  const byName = REGISTRY.get(ext);
  // The renderer is chosen by what the file IS (its bytes), the name only
  // when the bytes name nothing: a PDF stored without its extension, or under
  // a wrong one, still opens in the PDF viewer (#4523).
  const [loader, setLoader] = useState<RendererLoader | undefined>(byName);
  const [data, setData] = useState<{ blobUrl: string; bytes: ArrayBuffer } | null>(null);
  const [err, setErr] = useState(false);
  const [probed, setProbed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let blobUrl: string | null = null;
    setData(null);
    setErr(false);
    setProbed(false);
    setLoader(byName);
    const token = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
    const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    void (async () => {
      try {
        // No renderer by name: read only the first bytes to learn what it is
        // before fetching all of it (a large file with no preview stays unread).
        if (!byName) {
          const probe = await fetch(src, { headers: { ...auth, Range: "bytes=0-63" } });
          if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
          const head = new Uint8Array(await probe.arrayBuffer()).subarray(0, 64);
          const bySniff = rendererForType(sniffType(head));
          if (cancelled) return;
          setProbed(true);
          if (!bySniff) return;
          setLoader(() => bySniff);
        }
        const r = await fetch(src, { headers: auth });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        const ab = await blob.arrayBuffer();
        if (cancelled) return;
        const bySniff = rendererForType(sniffType(new Uint8Array(ab, 0, Math.min(64, ab.byteLength))));
        if (bySniff) setLoader(() => bySniff);
        blobUrl = URL.createObjectURL(blob);
        setData({ blobUrl, bytes: ab });
      } catch {
        if (!cancelled) setErr(true);
      }
    })();
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src, byName]);

  const Comp = useMemo(() => (loader ? lazy(loader) : null), [loader]);

  if (!loader && (probed || err))
    return <div className={`text-xs text-faint italic ${className ?? ""}`}>No preview for {ext ? `.${ext} ` : "these "}files</div>;
  if (err)
    return <div className={`text-xs text-faint italic ${className ?? ""}`}>Couldn't load preview</div>;
  if (!data || !Comp)
    return <div className={`text-xs text-faint ${className ?? ""}`}>Loading preview…</div>;

  return (
    <div className={className}>
      <Suspense fallback={<div className="text-xs text-faint">Loading…</div>}>
        <Comp blobUrl={data.blobUrl} bytes={data.bytes} filename={filename} />
      </Suspense>
    </div>
  );
}
