import { useEffect, useRef } from "react";
import type { PreviewRendererProps } from "@cobblr/platform-web";
import { mountMeshPreview } from "./mesh-preview";

// Interactive STL preview (orbit + auto-rotate) via three.js. The scene is
// shared with the 3MF renderer (mesh-preview.ts); STL only differs in how the
// geometry is produced — STLLoader.parse. three loads lazily (only on preview).
export default function StlRenderer({ bytes }: PreviewRendererProps) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let cleanup = () => {};
    void mountMeshPreview(el, async () => {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      return new STLLoader().parse(bytes);
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
