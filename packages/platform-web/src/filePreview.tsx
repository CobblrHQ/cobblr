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
  const loader = REGISTRY.get(ext);
  const [data, setData] = useState<{ blobUrl: string; bytes: ArrayBuffer } | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!loader) return;
    let cancelled = false;
    let blobUrl: string | null = null;
    setData(null);
    setErr(false);
    const token = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
    fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(async (blob) => {
        const ab = await blob.arrayBuffer();
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        setData({ blobUrl, bytes: ab });
      })
      .catch(() => {
        if (!cancelled) setErr(true);
      });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src, loader]);

  const Comp = useMemo(() => (loader ? lazy(loader) : null), [loader]);

  if (!loader)
    return <div className={`text-xs text-faint italic ${className ?? ""}`}>No preview for .{ext} files</div>;
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
