import polygonClipping from "polygon-clipping";
export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }
export interface SheetSpec { material: string; thickness_mm: number; width_mm: number; height_mm: number; minimum_usable_mm: number; offcut_percent: number }
export interface SheetState { used: Rect[]; edits: Rect[][]; sources: string[]; polygons?: Point[][] }
export interface SheetArea { free_rectangles: Rect[]; used_outlines: Point[][]; percent_left: number; offcut: boolean; cut_capacity: { shapes: number; vertices: number; sources: number } }
export const emptySheetState = (): SheetState => ({ used: [], edits: [], sources: [] });
const edgeX = (r: Rect) => r.x + r.width;
const edgeY = (r: Rect) => r.y + r.height;
const contains = (a: Rect, b: Rect) => a.x <= b.x && a.y <= b.y && edgeX(a) >= edgeX(b) && edgeY(a) >= edgeY(b);
const overlaps = (a: Rect, b: Rect) => a.x < edgeX(b) && edgeX(a) > b.x && a.y < edgeY(b) && edgeY(a) > b.y;
const whole = (s: SheetSpec): Rect => ({ x: 0, y: 0, width: s.width_mm, height: s.height_mm });
const clipped = (r: Rect, s: Rect): Rect => ({ x: Math.max(r.x, s.x), y: Math.max(r.y, s.y), width: Math.min(edgeX(r), edgeX(s)) - Math.max(r.x, s.x), height: Math.min(edgeY(r), edgeY(s)) - Math.max(r.y, s.y) });
const positive = (r: Rect) => r.width > 0 && r.height > 0;

export function sheetSpec(metadata: Record<string, unknown>): SheetSpec | null {
  const legacy = metadata.laser_sheet as Record<string, unknown> | undefined;
  const native = metadata.material != null && metadata.width_mm != null ? metadata : legacy;
  if (!native || typeof native.material !== "string" || !native.material.trim()) return null;
  const n = (key: string, fallback?: number) => native[key] == null || native[key] === "" ? fallback! : Number(native[key]);
  const s = { material: native.material.trim(), thickness_mm: n("thickness_mm"), width_mm: n("width_mm"), height_mm: n("height_mm"), minimum_usable_mm: Number(metadata.minimum_usable_mm ?? 20), offcut_percent: Number(metadata.offcut_percent ?? 25) };
  return [s.thickness_mm, s.width_mm, s.height_mm, s.minimum_usable_mm].every(v => Number.isFinite(v) && v > 0 && v <= 100000) && Number.isFinite(s.offcut_percent) && s.offcut_percent >= 0 && s.offcut_percent <= 100 ? s : null;
}

export function subtractRectangles(free: Rect[], used: Rect[], maximal = true): Rect[] {
  for (const cut of used) {
    const next: Rect[] = [];
    for (const r of free) {
      if (!overlaps(r, cut)) { next.push(r); continue; }
      const c = clipped(cut, r);
      if (c.x > r.x) next.push({ ...r, width: c.x - r.x });
      if (edgeX(c) < edgeX(r)) next.push({ ...r, x: edgeX(c), width: edgeX(r) - edgeX(c) });
      if (c.y > r.y) next.push({ x: maximal ? r.x : c.x, y: r.y, width: maximal ? r.width : c.width, height: c.y - r.y });
      if (edgeY(c) < edgeY(r)) next.push({ x: maximal ? r.x : c.x, y: edgeY(c), width: maximal ? r.width : c.width, height: edgeY(r) - edgeY(c) });
    }
    free = next.filter((r, i) => !next.some((other, j) => i !== j && contains(other, r) && (!contains(r, other) || j < i)));
    if (free.length > 4096) throw new Error("This sheet has too many separate areas to track. Use a simpler hand edit.");
  }
  return free;
}

function unionArea(rectangles: Rect[]): number {
  const xs = [...new Set(rectangles.flatMap(r => [r.x, edgeX(r)]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < xs.length; i++) {
    const intervals = rectangles.filter(r => r.x < xs[i]! && edgeX(r) > xs[i - 1]!).map(r => [r.y, edgeY(r)] as const).sort((a, b) => a[0] - b[0]);
    let length = 0, end = -Infinity;
    for (const [low, high] of intervals) { length += Math.max(0, high - Math.max(low, end)); end = Math.max(end, high); }
    total += (xs[i]! - xs[i - 1]!) * length;
  }
  return total;
}

function outlines(rectangles: Rect[]): Point[][] {
  if (!rectangles.length) return [];
  const xs = [...new Set(rectangles.flatMap(r => [r.x, edgeX(r)]))].sort((a, b) => a - b);
  const ys = [...new Set(rectangles.flatMap(r => [r.y, edgeY(r)]))].sort((a, b) => a - b);
  const cells = new Set<string>();
  for (let x = 0; x < xs.length - 1; x++) for (let y = 0; y < ys.length - 1; y++) {
    if (rectangles.some(r => r.x <= xs[x]! && edgeX(r) >= xs[x + 1]! && r.y <= ys[y]! && edgeY(r) >= ys[y + 1]!)) cells.add(`${x},${y}`);
  }
  const edges = new Map<string, Array<{ end: string; dir: number }>>();
  const add = (x: number, y: number, nx: number, ny: number, dir: number) => {
    const key = `${x},${y}`;
    edges.set(key, [...(edges.get(key) ?? []), { end: `${nx},${ny}`, dir }]);
  };
  for (const key of cells) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    if (!cells.has(`${x},${y - 1}`)) add(x, y, x + 1, y, 0);
    if (!cells.has(`${x + 1},${y}`)) add(x + 1, y, x + 1, y + 1, 1);
    if (!cells.has(`${x},${y + 1}`)) add(x + 1, y + 1, x, y + 1, 2);
    if (!cells.has(`${x - 1},${y}`)) add(x, y + 1, x, y, 3);
  }
  const result: Point[][] = [];
  while (edges.size) {
    const start = edges.keys().next().value!;
    const keys: string[] = [];
    let key = start, direction = edges.get(start)![0]!.dir;
    do {
      keys.push(key);
      const choices = edges.get(key)!;
      const index = Math.max(0, choices.findIndex(e => e.dir === (direction + 1) % 4));
      const edge = choices.splice(index, 1)[0]!;
      if (!choices.length) edges.delete(key);
      key = edge.end; direction = edge.dir;
    } while (key !== start);
    const points = keys.map(k => { const [x, y] = k.split(",").map(Number); return { x: xs[x!]!, y: ys[y!]! }; });
    result.push(points.filter((p, i) => {
      const before = points[(i + points.length - 1) % points.length]!, after = points[(i + 1) % points.length]!;
      return !(before.x === p.x && p.x === after.x || before.y === p.y && p.y === after.y);
    }));
  }
  const hasHoles = result.some(p => p.reduce((sum,v,i) => { const next=p[(i+1)%p.length]!; return sum+v.x*next.y-v.y*next.x; },0)<0);
  if (!hasHoles && result.every(p => p.length <= 24)) return result;
  // Exact strips keep gaps and holes when a boundary is too long to draw plainly.
  const strips: Rect[] = [];
  for (let y = 0; y < ys.length - 1; y++) {
    for (let x = 0; x < xs.length - 1; x++) {
      if (!cells.has(`${x},${y}`)) continue;
      const start = x;
      while (x + 1 < xs.length - 1 && cells.has(`${x + 1},${y}`)) x++;
      strips.push({ x: xs[start]!, y: ys[y]!, width: xs[x + 1]! - xs[start]!, height: ys[y + 1]! - ys[y]! });
    }
  }
  return strips.map(r => [{ x: r.x, y: r.y }, { x: edgeX(r), y: r.y }, { x: edgeX(r), y: edgeY(r) }, { x: r.x, y: edgeY(r) }]);
}

export function sheetArea(s: SheetSpec, state: SheetState): SheetArea {
  const used = state.used.map(r => clipped(r, whole(s))).filter(positive);
  const polygons = state.polygons ?? [];
  const free = subtractRectangles([whole(s)], [...used, ...polygons.map(polygonBounds)]).filter(r => r.width >= s.minimum_usable_mm && r.height >= s.minimum_usable_mm);
  const percent = polygons.length ? (s.width_mm * s.height_mm - occupiedArea([...used.map(rectPoints), ...polygons])) / (s.width_mm * s.height_mm) * 100 : unionArea(free) / (s.width_mm * s.height_mm) * 100;
  return { cut_capacity: { shapes: Math.max(0,512-state.used.length-polygons.length), vertices: Math.max(0,32768-state.used.length*4-polygons.reduce((n,p)=>n+p.length,0)), sources: Math.max(0,512-state.sources.length) }, free_rectangles: free, used_outlines: polygons.length ? [...used.map(rectPoints), ...polygons] : outlines(used), percent_left: percent, offcut: percent <= s.offcut_percent };
}
export function fitsSheet(area: SheetArea, width: number, height: number, rotate = true): boolean {
  return area.free_rectangles.some(r => r.width >= width && r.height >= height || rotate && r.width >= height && r.height >= width);
}
function validateRectangles(s: SheetSpec, rectangles: Rect[]) {
  if (rectangles.length > 128 || rectangles.some(r => ![r.x, r.y, r.width, r.height].every(Number.isFinite) || !positive(r) || !contains(whole(s), r))) throw new Error("Use up to 128 rectangles inside the sheet, with positive sizes.");
}
export function recordCut(s: SheetSpec, state: SheetState, boxes: Rect[], kerf: number, spacing: number, source?: string): SheetState {
  if (source && state.sources.includes(source)) return state;
  validateRectangles(s, boxes);
  if (!boxes.length || ![kerf, spacing].every(v => Number.isFinite(v) && v >= 0 && v <= 1000)) throw new Error("Give the cut rectangles, kerf and spacing in millimetres.");
  const margin = (kerf + spacing) / 2;
  const expanded = boxes.map(r => clipped({ x: r.x - margin, y: r.y - margin, width: r.width + margin * 2, height: r.height + margin * 2 }, whole(s)));
  if (expanded.some(r => state.used.some(c => overlaps(r, c)) || (state.polygons ?? []).some(p => intersects(rectPoints(r),p)))) throw new Error("This cut reaches an area already used. Check its position.");
  if (state.used.length + expanded.length + (state.polygons?.length ?? 0) > 512 || (state.used.length + expanded.length)*4 + (state.polygons ?? []).reduce((n,p)=>n+p.length,0) > 32768 || state.sources.length >= 512) throw new Error("This sheet has too many recorded cuts.");
  const next = { ...state, used: [...state.used, ...expanded], edits: [], sources: source ? [...state.sources, source] : state.sources };
  sheetArea(s, next);
  return next;
}
export function editFreeArea(s: SheetSpec, state: SheetState, free: Rect[]): SheetState {
  validateRectangles(s, free);
  if (free.some(r => state.used.some(c => overlaps(r, c)) || (state.polygons ?? []).some(p => intersects(rectPoints(r),p)))) throw new Error("A hand edit cannot restore an area already used. Undo the previous hand edit instead.");
  const used = subtractRectangles([whole(s)], free, false);
  if (used.length + (state.polygons?.length ?? 0) > 512 || used.length*4 + (state.polygons ?? []).reduce((n,p)=>n+p.length,0) > 32768) throw new Error("Use fewer rectangles for this hand edit.");
  const next = { ...state, used, edits: [...state.edits.slice(-19), state.used] };
  sheetArea(s, next);
  return next;
}
export function undoFreeEdit(state: SheetState): SheetState {
  if (!state.edits.length) throw new Error("No hand edit to undo.");
  return { ...state, used: state.edits[state.edits.length - 1]!, edits: state.edits.slice(0, -1) };
}
const rectPoints = (r: Rect): Point[] => [{x:r.x,y:r.y},{x:edgeX(r),y:r.y},{x:edgeX(r),y:edgeY(r)},{x:r.x,y:edgeY(r)}];
const ring = (p: Point[]): [number, number][] => [...p,p[0]!].map(v=>[v.x,v.y]);
const polygonBounds = (p: Point[]): Rect => { const x=Math.min(...p.map(v=>v.x)),y=Math.min(...p.map(v=>v.y));return {x,y,width:Math.max(...p.map(v=>v.x))-x,height:Math.max(...p.map(v=>v.y))-y}; };
const multiArea = (polygons: polygonClipping.MultiPolygon) => polygons.reduce((n,p)=>n+p.reduce((sum,r,i)=>sum+(i?-1:1)*Math.abs(r.reduce((a,v,j)=>{const b=r[(j+1)%r.length]!;return a+v[0]*b[1]-v[1]*b[0];},0))/2,0),0);
const occupiedArea = (p: Point[][]) => p.length ? multiArea(polygonClipping.union(...p.map(v=>[ring(v)] as polygonClipping.Polygon) as [polygonClipping.Polygon,...polygonClipping.Polygon[]])) : 0;
const intersects = (a: Point[], b: Point[]) => multiArea(polygonClipping.intersection([ring(a)],[ring(b)])) > 1e-5;
export function recordOutlineCut(s: SheetSpec, state: SheetState, polygons: Point[][], source?: string): SheetState {
 if (source && state.sources.includes(source)) return state;
 if (!polygons.length || polygons.length > 128 || polygons.some(p=>p.length<3||p.length>256||p.some(v=>!Number.isFinite(v.x)||!Number.isFinite(v.y)||v.x < -0.0001||v.y < -0.0001||v.x>s.width_mm+0.0001||v.y>s.height_mm+0.0001))) throw new Error("Use up to 128 cut outlines with 3 to 256 vertices inside the sheet.");
 const clean=polygons.map(p=>p.map(v=>({x:Math.max(0,Math.min(s.width_mm,v.x)),y:Math.max(0,Math.min(s.height_mm,v.y))})));
 const prior=[...state.used.map(rectPoints),...(state.polygons??[])];
 if (clean.some(p=>occupiedArea([p])<=1e-5 || prior.some(q=>intersects(p,q)))) throw new Error("This cut reaches an area already used or has an invalid outline. Check its position.");
 const all=[...(state.polygons??[]),...clean];
 if (state.used.length+all.length>512 || state.used.length*4+all.reduce((n,p)=>n+p.length,0)>32768 || state.sources.length>=512) throw new Error("This sheet has too many recorded cut outlines.");
 const next={...state,polygons:all,edits:[],sources:source?[...state.sources,source]:state.sources};
 sheetArea(s,next);
 return next;
}
