import { useEffect, useRef } from "react";
import type { PreviewRendererProps } from "@cobblr/platform-web";
import { parseDxf } from "./dxf-parse";

// 2D top-down preview of a DXF (laser/CNC cut file). Draws LINE / LWPOLYLINE /
// CIRCLE / ARC fitted to the canvas. Arcs are tessellated into short segments
// so the Y-flip (DXF is Y-up, canvas is Y-down) can't invert their direction.
export default function DxfRenderer({ bytes }: PreviewRendererProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const text = new TextDecoder().decode(new Uint8Array(bytes));
    const geom = parseDxf(text);
    const W = cv.width, H = cv.height, pad = 16;
    ctx.clearRect(0, 0, W, H);
    if (geom.empty) return;
    const { minX, minY, maxX, maxY } = geom.bounds;
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const ox = pad + ((W - 2 * pad) - scale * spanX) / 2;
    const oy = pad + ((H - 2 * pad) - scale * spanY) / 2;
    const px = (X: number) => ox + scale * (X - minX);
    const py = (Y: number) => H - (oy + scale * (Y - minY)); // DXF Y is up

    ctx.lineWidth = 0.9;
    ctx.strokeStyle = "rgb(139,115,85)"; // cobble accent
    ctx.beginPath();
    for (const s of geom.segs) {
      ctx.moveTo(px(s.x0), py(s.y0));
      ctx.lineTo(px(s.x1), py(s.y1));
    }
    for (const a of geom.arcs) {
      let sweep = a.a1 - a.a0;
      while (sweep <= 0) sweep += 360;
      const steps = Math.max(8, Math.ceil(sweep / 4));
      for (let i = 0; i <= steps; i++) {
        const ang = ((a.a0 + sweep * (i / steps)) * Math.PI) / 180;
        const X = a.cx + a.r * Math.cos(ang);
        const Y = a.cy + a.r * Math.sin(ang);
        if (i === 0) ctx.moveTo(px(X), py(Y));
        else ctx.lineTo(px(X), py(Y));
      }
    }
    ctx.stroke();
  }, [bytes]);

  return (
    <canvas
      ref={ref}
      width={480}
      height={480}
      className="mx-auto block bg-surface rounded border border-line"
    />
  );
}
