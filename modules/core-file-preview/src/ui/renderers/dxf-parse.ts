// Minimal DXF (2D CAD / laser-cutter) parser — enough to PREVIEW a job, not
// to edit it. DXF is a flat stream of (group-code, value) line pairs; we walk
// the ENTITIES and pull the four shapes that cover the vast majority of
// laser/CNC files: LINE, LWPOLYLINE, CIRCLE, ARC. Everything else is ignored.
// Pure + dependency-free so it can be unit-tested in node without a browser.

export interface DxfSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface DxfArc {
  cx: number;
  cy: number;
  r: number;
  a0: number; // start angle, degrees (0 / 360 for a full circle)
  a1: number; // end angle, degrees
}
export interface DxfGeom {
  segs: DxfSeg[];
  arcs: DxfArc[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  empty: boolean;
}

interface Entity {
  type: string;
  codes: Array<[number, string]>;
}

function toPairs(text: string): Array<[number, string]> {
  const lines = text.split(/\r?\n/);
  const pairs: Array<[number, string]> = [];
  // DXF is strictly: code line, value line, code line, value line, …
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i]!.trim(), 10);
    if (Number.isNaN(code)) {
      // Not a clean pair boundary — resync by advancing one line.
      i -= 1;
      continue;
    }
    pairs.push([code, lines[i + 1]!]);
  }
  return pairs;
}

function groupEntities(pairs: Array<[number, string]>): Entity[] {
  const entities: Entity[] = [];
  let cur: Entity | null = null;
  for (const [code, val] of pairs) {
    if (code === 0) {
      if (cur) entities.push(cur);
      cur = { type: val.trim().toUpperCase(), codes: [] };
    } else if (cur) {
      cur.codes.push([code, val]);
    }
  }
  if (cur) entities.push(cur);
  return entities;
}

const first = (e: Entity, code: number): number | undefined => {
  for (const [c, v] of e.codes) if (c === code) return parseFloat(v);
  return undefined;
};

export function parseDxf(text: string): DxfGeom {
  const entities = groupEntities(toPairs(text));
  const segs: DxfSeg[] = [];
  const arcs: DxfArc[] = [];

  for (const e of entities) {
    switch (e.type) {
      case "LINE": {
        const x0 = first(e, 10), y0 = first(e, 20);
        const x1 = first(e, 11), y1 = first(e, 21);
        if ([x0, y0, x1, y1].every((n) => n !== undefined)) {
          segs.push({ x0: x0!, y0: y0!, x1: x1!, y1: y1! });
        }
        break;
      }
      case "CIRCLE": {
        const cx = first(e, 10), cy = first(e, 20), r = first(e, 40);
        if (cx !== undefined && cy !== undefined && r) {
          arcs.push({ cx, cy, r, a0: 0, a1: 360 });
        }
        break;
      }
      case "ARC": {
        const cx = first(e, 10), cy = first(e, 20), r = first(e, 40);
        const a0 = first(e, 50), a1 = first(e, 51);
        if (cx !== undefined && cy !== undefined && r && a0 !== undefined && a1 !== undefined) {
          arcs.push({ cx, cy, r, a0, a1 });
        }
        break;
      }
      case "LWPOLYLINE":
      case "POLYLINE": {
        // Vertices: ordered, interleaved 10 (x) / 20 (y) pairs.
        const xs: number[] = [];
        const ys: number[] = [];
        for (const [c, v] of e.codes) {
          if (c === 10) xs.push(parseFloat(v));
          else if (c === 20) ys.push(parseFloat(v));
        }
        const closed = (first(e, 70) ?? 0) % 2 === 1; // bit 1 = closed
        const n = Math.min(xs.length, ys.length);
        for (let i = 1; i < n; i++) {
          segs.push({ x0: xs[i - 1]!, y0: ys[i - 1]!, x1: xs[i]!, y1: ys[i]! });
        }
        if (closed && n > 2) {
          segs.push({ x0: xs[n - 1]!, y0: ys[n - 1]!, x1: xs[0]!, y1: ys[0]! });
        }
        break;
      }
      default:
        break; // SECTION/ENDSEC/HEADER/TEXT/… — ignored for preview
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const s of segs) {
    grow(s.x0, s.y0);
    grow(s.x1, s.y1);
  }
  for (const a of arcs) {
    grow(a.cx - a.r, a.cy - a.r);
    grow(a.cx + a.r, a.cy + a.r);
  }
  const empty = segs.length === 0 && arcs.length === 0;
  return { segs, arcs, bounds: { minX, minY, maxX, maxY }, empty };
}
