import type { PreviewRendererProps } from "@cobblr/platform-web";

// SVG is already a renderable image. We show it through an <img> (from the
// blob: URL) rather than inlining the markup — `<img>` never executes
// scripts inside an SVG, so an untrusted file can't run anything.
export default function SvgRenderer({ blobUrl, filename }: PreviewRendererProps) {
  return (
    <img
      src={blobUrl}
      alt={filename}
      className="max-h-[480px] max-w-full object-contain mx-auto block bg-white rounded border border-line p-2"
    />
  );
}
