import { useEffect, useRef } from "react";
import type { PreviewRendererProps } from "@cobblr/platform-web";
import { mountMeshPreview } from "./mesh-preview";
import { parse3mf } from "./threemf-parse";

// Interactive 3MF preview (orbit + auto-rotate). Unzips the OPC archive, pulls
// the mesh from the model XML (threemf-parse), and hands a BufferGeometry to
// the shared three.js viewer. three loads lazily (only on preview).
export default function ThreeMfRenderer({ bytes }: PreviewRendererProps) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let cleanup = () => {};
    const geom = parse3mf(new Uint8Array(bytes));
    if (geom.empty) return; // nothing renderable — leave the empty frame
    void mountMeshPreview(el, (THREE) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(geom.positions, 3));
      if (geom.colors) g.setAttribute("color", new THREE.Float32BufferAttribute(geom.colors, 3));
      g.setIndex(geom.indices);
      return g;
    }).then((dispose) => {
      if (cancelled) dispose();
      else cleanup = dispose;
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [bytes]);

  return <div ref={host} className="w-full h-[480px] mx-auto bg-surface rounded border border-line" />;
}
