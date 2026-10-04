import type { PreviewRendererProps } from "@cobblr/platform-web";
import { useEffect, useState } from "react";

// SVG is already a renderable image. We show it through an <img> (from the
// blob: URL) rather than inlining the markup — `<img>` never executes
// scripts inside an SVG, so an untrusted file can't run anything.
export default function SvgRenderer({ bytes, filename }: PreviewRendererProps) {
  const [image, setImage] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
    setImage(url);
    return () => URL.revokeObjectURL(url);
  }, [bytes]);
  return (
    <img
      src={image}
      alt={filename}
      className="h-full max-h-[480px] max-w-full object-contain mx-auto block bg-white dark:bg-white rounded border border-line p-2"
    />
  );
}
