import { useEffect, useRef } from "react";
import type { PreviewRendererProps } from "@cobblr/platform-web";

// Top-down (XY) toolpath preview. Parses G0/G1 moves and draws the path:
// printed (extruding) moves in the accent colour, travel moves faint. Not
// a slicer or a 3D layer view — just "what does this job lay down."
export default function GcodeRenderer({ bytes }: PreviewRendererProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const text = new TextDecoder().decode(new Uint8Array(bytes));

    type Seg = { x0: number; y0: number; x1: number; y1: number; printed: boolean };
    const segs: Seg[] = [];
    let x = 0, y = 0, e = 0, abs = true, relE = false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const lines = text.split("\n");
    const CAP = 600_000; // sample the head of huge files rather than choke
    for (let i = 0; i < Math.min(lines.length, CAP); i++) {
      let line = lines[i]!;
      const semi = line.indexOf(";");
      if (semi >= 0) line = line.slice(0, semi);
      line = line.trim();
      if (!line) continue;
      const t = line.split(/\s+/);
      const code = t[0]!.toUpperCase();
      if (code === "G90") abs = true;
      else if (code === "G91") abs = false;
      else if (code === "M82") relE = false;
      else if (code === "M83") relE = true;
      else if (code === "G0" || code === "G1") {
        let nx = x, ny = y, ne = e, hasE = false;
        for (let k = 1; k < t.length; k++) {
          const a = t[k]!;
          const v = parseFloat(a.slice(1));
          if (Number.isNaN(v)) continue;
          const axis = a[0]!.toUpperCase();
          if (axis === "X") nx = abs ? v : x + v;
          else if (axis === "Y") ny = abs ? v : y + v;
          else if (axis === "E") { hasE = true; ne = relE ? e + v : v; }
        }
        const printed = hasE && ne > e + 1e-6;
        if (nx !== x || ny !== y) {
          segs.push({ x0: x, y0: y, x1: nx, y1: ny, printed });
          if (printed) {
            minX = Math.min(minX, x, nx); minY = Math.min(minY, y, ny);
            maxX = Math.max(maxX, x, nx); maxY = Math.max(maxY, y, ny);
          }
        }
        x = nx; y = ny; e = ne;
      }
    }

    const W = cv.width, H = cv.height, pad = 16;
    ctx.clearRect(0, 0, W, H);
    // No printed moves found → bound by all moves so something still shows.
    if (!isFinite(minX)) {
      for (const s of segs) {
        minX = Math.min(minX, s.x0, s.x1); minY = Math.min(minY, s.y0, s.y1);
        maxX = Math.max(maxX, s.x0, s.x1); maxY = Math.max(maxY, s.y0, s.y1);
      }
    }
    if (!isFinite(minX) || maxX === minX || maxY === minY) return;
    const scale = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const ox = pad + ((W - 2 * pad) - scale * (maxX - minX)) / 2;
    const oy = pad + ((H - 2 * pad) - scale * (maxY - minY)) / 2;
    const px = (X: number) => ox + scale * (X - minX);
    const py = (Y: number) => H - (oy + scale * (Y - minY)); // flip: printer Y is up

    const stroke = (printed: boolean) => {
      ctx.beginPath();
      for (const s of segs) {
        if (s.printed !== printed) continue;
        ctx.moveTo(px(s.x0), py(s.y0));
        ctx.lineTo(px(s.x1), py(s.y1));
      }
      ctx.stroke();
    };
    ctx.lineWidth = 0.5; ctx.strokeStyle = "rgba(120,130,150,0.25)"; stroke(false); // travel
    ctx.lineWidth = 0.85; ctx.strokeStyle = "rgb(139,115,85)"; stroke(true); // printed (cobble)
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
