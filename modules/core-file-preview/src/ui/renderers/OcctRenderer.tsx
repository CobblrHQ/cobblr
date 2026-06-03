/// <reference path="../../occt-import-js.d.ts" />
import { useEffect, useRef, useState } from "react";
import type { PreviewRendererProps } from "@cobblr/platform-web";
import occtFactory from "occt-import-js";
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";
import { mountMeshPreview } from "./mesh-preview";
import { readOcct, occtKindForFilename } from "./occt-parse";

// Interactive STEP / IGES preview. Both are B-rep CAD, so we tessellate to a
// mesh with occt-import-js (OpenCASCADE WASM) before handing it to the shared
// three.js viewer. Multi-colour assemblies keep their per-solid colours; a
// single-colour part uses the default material. The whole renderer is
// lazy-registered, so the ~96KB occt JS only loads on first open; the 7.6MB
// WASM is a separate asset fetched at init (hence the loading state).
export default function OcctRenderer({ bytes, filename }: PreviewRendererProps) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let cleanup = () => {};
    const kind = occtKindForFilename(filename);
    const label = kind.toUpperCase();
    void (async () => {
      try {
        const occt = await occtFactory({ locateFile: () => wasmUrl });
        if (cancelled) return;
        const geom = readOcct(occt, new Uint8Array(bytes), kind);
        if (geom.empty) {
          if (!cancelled) setStatus("empty");
          return;
        }
        cleanup = await mountMeshPreview(el, (THREE) => {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.Float32BufferAttribute(geom.positions, 3));
          if (geom.colors) g.setAttribute("color", new THREE.Float32BufferAttribute(geom.colors, 3));
          g.setIndex(geom.indices);
          return g;
        });
        if (cancelled) cleanup();
        else setStatus("ready");
      } catch (err) {
        console.error(`[core-file-preview] ${label} render failed:`, err);
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [bytes, filename]);

  const label = occtKindForFilename(filename).toUpperCase();
  return (
    <div className="relative w-full h-[480px] mx-auto bg-surface rounded border border-line">
      <div ref={host} className="w-full h-full" />
      {status !== "ready" && (
        <div className="absolute inset-0 grid place-items-center px-4 text-center text-sm text-muted">
          {status === "loading" && `Loading ${label}… (first open downloads the CAD kernel)`}
          {status === "empty" && `No renderable geometry in this ${label} file.`}
          {status === "error" && `Couldn't render this ${label} file.`}
        </div>
      )}
    </div>
  );
}
