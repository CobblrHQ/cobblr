// A planning layout on paper, to take into the room: drawn in real
// millimetres at a standard scale (1:40), landscape, fitting letter and A4.
// Page one is the floor: the walls with their doors and windows, the room's
// size, every rack with its size and its distance from the two nearest walls,
// a scale bar. Then each rack's front, with what stands on every shelf, the
// sizes, and whether it fits. Always light: its one job is paper.
// The arithmetic is lib/layoutPrint.ts.

import { labelFor, type Board, type BoardRack } from "../lib/layoutBoard";
import { wallSegments, type FpBound } from "../lib/floorplanGeometry";
import { nameUnder } from "../lib/planFit";
import { nearestWalls, printScale, scaleBarMm } from "../lib/layoutPrint";

const n = (v: number) => Math.round(v).toLocaleString("en-US");
/** What an opening is called on paper. */
const OPENING_WORDS: Record<"door" | "window" | "opening", string> = { door: "door", window: "window", opening: "opening" };
/** Paper margin around the drawing for dimension lines, in paper mm. */
const MARGIN = 14;

/** Does a dimension line pass through a rect? */
function crosses(g: { x1: number; y1: number; x2: number; y2: number }, r: { x_mm: number; y_mm: number; w_mm: number; d_mm: number }): boolean {
  const [x1, x2] = [Math.min(g.x1, g.x2), Math.max(g.x1, g.x2)];
  const [y1, y2] = [Math.min(g.y1, g.y2), Math.max(g.y1, g.y2)];
  return x1 < r.x_mm + r.w_mm && x2 > r.x_mm && y1 < r.y_mm + r.d_mm && y2 > r.y_mm;
}

/** Chain dimensions: one line above the room and one to its left, ticked at
 *  every rack edge, each span labelled with its length. */
function ChainDims({ racks, bound, m, font, thin }: { racks: Array<{ x_mm: number; y_mm: number; w_mm: number; d_mm: number }>; bound: FpBound; m: number; font: number; thin: number }) {
  if (!racks.length) return null;
  const xs = [...new Set([0, bound.w_mm, ...racks.flatMap((r) => [Math.round(r.x_mm), Math.round(r.x_mm + r.w_mm)])])].sort((a, b) => a - b);
  const ys = [...new Set([0, bound.d_mm, ...racks.flatMap((r) => [Math.round(r.y_mm), Math.round(r.y_mm + r.d_mm)])])].sort((a, b) => a - b);
  const yLine = -m * 0.2;
  const xLine = -m * 0.2;
  return (
    <g data-chain-dims="">
      <line x1={0} y1={yLine} x2={bound.w_mm} y2={yLine} stroke="black" strokeWidth={thin} />
      {xs.map((x) => <line key={`tx${x}`} x1={x} y1={yLine - font / 3} x2={x} y2={yLine + font / 3} stroke="black" strokeWidth={thin} />)}
      {xs.slice(1).map((x, i) => {
        const span = x - xs[i]!;
        return span * 1 >= font * 2.2 ? (
          <text key={`lx${x}`} data-print-text="" x={(x + xs[i]!) / 2} y={yLine - font * 0.3} fontSize={font * 0.8} textAnchor="middle">
            {n(span)}
          </text>
        ) : null;
      })}
      <line x1={xLine} y1={0} x2={xLine} y2={bound.d_mm} stroke="black" strokeWidth={thin} />
      {ys.map((y) => <line key={`ty${y}`} x1={xLine - font / 3} y1={y} x2={xLine + font / 3} y2={y} stroke="black" strokeWidth={thin} />)}
      {ys.slice(1).map((y, i) => {
        const span = y - ys[i]!;
        const cy = (y + ys[i]!) / 2;
        return span >= font * 2.2 ? (
          <text key={`ly${y}`} data-print-text="" x={xLine - font * 0.3} y={cy} fontSize={font * 0.8} textAnchor="middle" transform={`rotate(-90 ${xLine - font * 0.3} ${cy})`}>
            {n(span)}
          </text>
        ) : null;
      })}
    </g>
  );
}

function Floor({ board, bound }: { board: Board; bound: FpBound }) {
  const s = printScale(bound.w_mm, bound.d_mm);
  const m = MARGIN * s;
  const font = 2.6 * s;
  const thin = 0.25 * s;
  const bar = scaleBarMm(bound.w_mm);
  const racks = board.racks.filter((r) => r.rect);
  return (
    <section data-print-floor="" className="print-page">
      <p className="mb-1 text-[11px]">
        Floor, scale 1:{s}. Sizes in millimetres; each rack is measured from its two nearest walls.
      </p>
      <svg
        data-print-scale={s}
        width={`${(bound.w_mm + 2 * m) / s}mm`}
        height={`${(bound.d_mm + 2 * m) / s}mm`}
        viewBox={`${-m} ${-m} ${bound.w_mm + 2 * m} ${bound.d_mm + 2 * m}`}
        className="block text-black"
        fontFamily="Helvetica, Arial, sans-serif"
      >
        <rect x={0} y={0} width={bound.w_mm} height={bound.d_mm} fill="none" stroke="black" strokeWidth={0.8 * s} />
        {/* Interior walls, drawn minus their openings; an opening on the
            outer wall is a white gap in it. Each opening says what and how wide. */}
        {(bound.walls ?? []).map((w, i) => {
          const onEdge = (w.x1 === w.x2 && (w.x1 === 0 || w.x1 === bound.w_mm)) || (w.y1 === w.y2 && (w.y1 === 0 || w.y1 === bound.d_mm));
          const vertical = w.x1 === w.x2;
          const start = vertical ? Math.min(w.y1, w.y2) : Math.min(w.x1, w.x2);
          return (
            <g key={i}>
              {!onEdge && wallSegments(w).map((g, k) => <line key={k} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="black" strokeWidth={0.6 * s} />)}
              {(w.openings ?? []).map((o, k) => {
                const a = start + o.at_mm, b = a + o.w_mm;
                const [x1, y1, x2, y2] = vertical ? [w.x1, a, w.x1, b] : [a, w.y1, b, w.y1];
                const said = OPENING_WORDS[o.kind ?? "opening"];
                return (
                  <g key={`o${k}`}>
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="white" strokeWidth={1.4 * s} />
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="black" strokeWidth={thin} strokeDasharray={`${s} ${s}`} />
                    <text
                      data-print-text=""
                      x={(x1 + x2) / 2 + (vertical ? font * 0.6 : 0)}
                      y={(y1 + y2) / 2 + (vertical ? 0 : y1 >= bound.d_mm ? -font * 0.5 : font * 1.2)}
                      fontSize={font}
                      textAnchor={vertical ? "start" : "middle"}
                    >
                      {said} {n(o.w_mm)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
        {/* The room's size, along its top and left. */}
        <g stroke="black" strokeWidth={thin}>
          <line x1={0} y1={-m * 0.7} x2={bound.w_mm} y2={-m * 0.7} />
          <line x1={0} y1={-m * 0.7 - font / 2} x2={0} y2={-m * 0.7 + font / 2} />
          <line x1={bound.w_mm} y1={-m * 0.7 - font / 2} x2={bound.w_mm} y2={-m * 0.7 + font / 2} />
          <line x1={-m * 0.7} y1={0} x2={-m * 0.7} y2={bound.d_mm} />
          <line x1={-m * 0.7 - font / 2} y1={0} x2={-m * 0.7 + font / 2} y2={0} />
          <line x1={-m * 0.7 - font / 2} y1={bound.d_mm} x2={-m * 0.7 + font / 2} y2={bound.d_mm} />
        </g>
        <text data-print-text="" x={bound.w_mm / 2} y={-m * 0.7 - font * 0.4} fontSize={font} textAnchor="middle">
          {n(bound.w_mm)}
        </text>
        <text data-print-text="" x={-m * 0.7 - font * 0.4} y={bound.d_mm / 2} fontSize={font} textAnchor="middle" transform={`rotate(-90 ${-m * 0.7 - font * 0.4} ${bound.d_mm / 2})`}>
          {n(bound.d_mm)}
        </text>
        {/* Racks: their footprint, name and size, and where they stand. */}
        {/* Chain dimensions along the top and the left: every rack's edges
            measured from the walls, so each rack can be set out with a tape. */}
        <ChainDims racks={racks.map((r) => r.rect!)} bound={bound} m={m} font={font} thin={thin} />
        {racks.map((r) => {
          const rect = r.rect!;
          // A rack's own line to its nearest wall, where nothing stands between.
          const walls = nearestWalls(rect, bound).filter((g) => !racks.some((o) => o !== r && crosses(g, o.rect!)));
          return (
            <g key={r.id} data-print-rack={r.id}>
              <rect x={rect.x_mm} y={rect.y_mm} width={rect.w_mm} height={rect.d_mm} fill="white" stroke="black" strokeWidth={0.5 * s} strokeDasharray={r.planned ? `${2 * s} ${s}` : undefined} />
              <text data-print-text="" x={rect.x_mm + rect.w_mm / 2} y={rect.y_mm + rect.d_mm / 2 - font * 0.15} fontSize={font} textAnchor="middle" fontWeight="bold">
                {r.name}
                {r.planned ? " (planned)" : ""}
              </text>
              <text data-print-text="" x={rect.x_mm + rect.w_mm / 2} y={rect.y_mm + rect.d_mm / 2 + font * 1.05} fontSize={font * 0.85} textAnchor="middle">
                {n(rect.w_mm)} × {n(rect.d_mm)}
              </text>
              {walls.map((g) =>
                g.mm > 0 ? (
                  <g key={g.side}>
                    <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="black" strokeWidth={thin} markerStart="url(#tick)" markerEnd="url(#tick)" />
                    <text
                      data-print-text=""
                      x={(g.x1 + g.x2) / 2 + (g.x1 === g.x2 ? font * 0.4 : 0)}
                      y={(g.y1 + g.y2) / 2 + (g.x1 === g.x2 ? font * 0.35 : -font * 0.3)}
                      fontSize={font * 0.85}
                      textAnchor={g.x1 === g.x2 ? "start" : "middle"}
                    >
                      {n(g.mm)}
                    </text>
                  </g>
                ) : null,
              )}
            </g>
          );
        })}
        {board.floor.filter((t) => t.rect).map((t) => (
          <g key={t.key}>
            <rect x={t.rect!.x_mm} y={t.rect!.y_mm} width={t.rect!.w_mm} height={t.rect!.d_mm} fill="white" stroke="black" strokeWidth={0.35 * s} />
            <text data-print-text="" x={t.rect!.x_mm + t.rect!.w_mm / 2} y={t.rect!.y_mm + t.rect!.d_mm / 2} fontSize={font * 0.85} textAnchor="middle">
              {labelFor(t.name, t.short, t.rect!.w_mm, font * 1.2, font * 0.85 * 0.56, font * 1.1)}
            </text>
          </g>
        ))}
        <defs>
          <marker id="tick" viewBox="-1 -5 2 10" markerWidth={2} markerHeight={6} orient="auto">
            <line x1={0} y1={-4} x2={0} y2={4} stroke="black" strokeWidth={1} />
          </marker>
        </defs>
        {/* Scale bar, under the drawing. */}
        <g data-scale-bar="" transform={`translate(0 ${bound.d_mm + m * 0.55})`}>
          <rect x={0} y={0} width={bar / 2} height={font * 0.5} fill="black" />
          <rect x={bar / 2} y={0} width={bar / 2} height={font * 0.5} fill="white" stroke="black" strokeWidth={thin} />
          <text data-print-text="" x={bar + font * 0.6} y={font * 0.5} fontSize={font}>
            {bar >= 1000 ? `${bar / 1000} m` : `${bar} mm`} at 1:{s}
          </text>
        </g>
      </svg>
    </section>
  );
}

function RackFront({ rack }: { rack: BoardRack }) {
  const face = rack.face!;
  const s = printScale(face.w_mm, face.d_mm, { w: 95, h: 140 });
  const font = 2.4 * s;
  return (
    <section data-print-face={rack.id} className="mb-4 flex gap-6" style={{ breakInside: "avoid" }}>
      <div>
        <p className="mb-1 text-[11px] font-semibold">
          {rack.name}
          {rack.planned ? " (planned)" : ""}: front, {n(face.w_mm)} × {n(face.d_mm)}, scale 1:{s}
        </p>
        <svg width={`${face.w_mm / s}mm`} height={`${face.d_mm / s}mm`} viewBox={`0 0 ${face.w_mm} ${face.d_mm}`} className="block text-black" fontFamily="Helvetica, Arial, sans-serif">
          <rect x={0} y={0} width={face.w_mm} height={face.d_mm} fill="white" stroke="black" strokeWidth={0.6 * s} />
          {rack.shelves.map((sh) => (
            <g key={sh.id}>
              <line x1={sh.rect.x_mm} y1={sh.rect.y_mm + sh.rect.d_mm} x2={sh.rect.x_mm + sh.rect.w_mm} y2={sh.rect.y_mm + sh.rect.d_mm} stroke="black" strokeWidth={0.5 * s} />
              <text data-print-text="" x={sh.rect.x_mm + font * 0.3} y={sh.rect.y_mm + font * 1.05} fontSize={font}>
                {nameUnder(sh.name, rack.name)}
              </text>
              {sh.things.map((t) => (
                <g key={t.key}>
                  <rect x={t.rect!.x_mm} y={t.rect!.y_mm} width={t.rect!.w_mm} height={t.rect!.d_mm} fill="white" stroke="black" strokeWidth={0.35 * s} strokeDasharray={t.overhang || t.tooTall ? `${s} ${s}` : undefined} />
                  <text data-print-text="" x={t.rect!.x_mm + t.rect!.w_mm / 2} y={t.rect!.y_mm + t.rect!.d_mm / 2} fontSize={font * 0.9} textAnchor="middle">
                    {/* One line on paper: the whole name when it fits the box, else shorter. */}
                    {labelFor(t.name, t.short, t.rect!.w_mm, font * 1.2, font * 0.9 * 0.56, font * 1.1)}
                  </text>
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>
      <table className="h-min border-collapse text-[10px]">
        <thead>
          <tr className="text-left">
            <th className="pr-3">Shelf</th>
            <th className="pr-3">On it (W × D × H, mm)</th>
            <th>Fit</th>
          </tr>
        </thead>
        <tbody>
          {rack.shelves.map((sh) => (
            <tr key={sh.id} className="align-top border-t border-black/30">
              <td className="pr-3 py-0.5">{nameUnder(sh.name, rack.name)}</td>
              <td className="pr-3 py-0.5">
                {sh.things.map((t) => (
                  <div key={t.key}>
                    {t.name}: {n(t.size!.w_mm)} × {n(t.size!.d_mm)}
                    {t.size!.h_mm ? ` × ${n(t.size!.h_mm)}` : ""}
                    {t.overhang ? ", hangs off the front" : ""}
                    {t.tooTall ? ", taller than the space" : ""}
                  </div>
                ))}
                {sh.unsized.map((t) => (
                  <div key={t.key}>{t.name}: no size</div>
                ))}
                {!sh.things.length && !sh.unsized.length && <span>empty</span>}
              </td>
              <td className={`py-0.5 ${sh.row && !sh.row.fits ? "font-semibold" : ""}`}>{sh.line ? sh.line.replace(/^.*?, /, "") : `${n(sh.rect.w_mm)} mm free`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The whole printout: the floor, then every rack's front. */
export function LayoutPrint({ board }: { board: Board }) {
  const b = board.room.bound;
  const faces = board.racks.filter((r) => r.face && r.shelves.length);
  return (
    <div className="text-black">
      {b && <Floor board={board} bound={b} />}
      {faces.length > 0 && (
        <section data-print-fronts="" style={{ breakBefore: "page" }} className="pt-2">
          <p className="mb-2 text-[11px]">Racks from the front: what stands on each shelf, and whether it fits.</p>
          {faces.map((r) => (
            <RackFront key={r.id} rack={r} />
          ))}
        </section>
      )}
    </div>
  );
}
