// What a plan's walls say, drawn as plans draw them: a window is a thin
// double line in the wall, a door is its leaf standing open with the quarter
// circle it sweeps, and a plain opening is a gap. The floor a door sweeps is
// tinted; red when something stands in it. One layer for the floor plan and
// the planner, over the plan in its own mm (the geometry is
// @cobblr/platform-contract/plan-clearance).

import { blocksSwing, doorSwing, edgeOf, gapsAround, openingSpan, wallSegments, type DoorSwing, type Gap, type PlanBox, type PlanFlag, type PlanItem, type PlanWall } from "@cobblr/platform-contract/plan-clearance";

const n = (v: number) => Math.round(v).toLocaleString("en-US");

/** The walls' drawn thickness on the plan, in its mm: thin enough for a
 *  closet, thick enough to read on a phone. */
export const wallMm = (room: { w_mm: number; d_mm: number }) => Math.max(30, Math.min(120, Math.round(Math.max(room.w_mm, room.d_mm) / 110)));

export function PlanSymbols({
  room,
  walls,
  boxes,
  solid,
}: {
  room: { w_mm: number; d_mm: number };
  walls: readonly PlanWall[];
  /** What stands on the floor, to tint a door whose swing it is in. */
  boxes: readonly PlanBox[];
  /** Which walls this layer draws itself: every one on the planner; on the
   *  floor plan only a closet's, since the plan draws its own walls to drag
   *  and a closet's walls are drawn from the closet. */
  solid: (w: PlanWall) => boolean;
}) {
  const t = wallMm(room);
  return (
    <svg
      aria-hidden
      data-plan-symbols=""
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      viewBox={`0 0 ${room.w_mm} ${room.d_mm}`}
      preserveAspectRatio="none"
    >
      {walls.flatMap((w, i) =>
          !solid(w) ? [] : wallSegments(w).map((s, k) => (
            <line key={`w${i}-${k}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} className="stroke-slate-500 dark:stroke-slate-400" strokeWidth={t} strokeLinecap="square" />
          )),
        )}
      {walls.flatMap((w, i) =>
        (w.openings ?? []).map((o, k) => {
          const { vertical, c, a, b } = openingSpan(w, o);
          if (b <= a) return null;
          const line = (off: number, cls: string, width: number, key: string, dash?: string) =>
            vertical ? (
              <line key={key} x1={c + off} y1={a} x2={c + off} y2={b} className={cls} strokeWidth={width} strokeDasharray={dash} />
            ) : (
              <line key={key} x1={a} y1={c + off} x2={b} y2={c + off} className={cls} strokeWidth={width} strokeDasharray={dash} />
            );
          // A gap in the wall. An outer wall is the plan's own border, which
          // sits just outside the drawing, so the gap reaches over it.
          const gapWidth = edgeOf(w, room) ? t * 2.6 : t * 1.4;
          const gap = line(0, "stroke-surface dark:stroke-slate-900", gapWidth, "gap");
          const key = `o${i}-${k}`;
          if (o.kind === "window") {
            return (
              <g key={key} data-plan-window={`${i}:${k}`}>
                {gap}
                {line(-t / 2, "stroke-slate-500 dark:stroke-slate-400", t / 4, "a")}
                {line(t / 2, "stroke-slate-500 dark:stroke-slate-400", t / 4, "b")}
                {line(0, "stroke-sky-500/70 dark:stroke-sky-400/60", t / 5, "glass")}
              </g>
            );
          }
          const s = doorSwing(w, o);
          if (!s) return <g key={key} data-plan-opening={`${i}:${k}`}>{gap}</g>;
          const blocked = boxes.some((bx) => blocksSwing(bx, s));
          // The arc from the leaf shut to the leaf open, about the hinge.
          const arc = `M ${s.shut.x_mm} ${s.shut.y_mm} ${arcTo(s)}`;
          const wedge = `M ${s.hinge.x_mm} ${s.hinge.y_mm} L ${s.shut.x_mm} ${s.shut.y_mm} ${arcTo(s)} Z`;
          return (
            <g key={key} data-plan-door={`${i}:${k}`} data-blocked={blocked ? "true" : undefined}>
              {gap}
              <path d={wedge} className={blocked ? "fill-ember-500/25 dark:fill-ember-400/25" : "fill-slate-400/15 dark:fill-slate-400/10"} />
              <path d={arc} fill="none" className={blocked ? "stroke-ember-600 dark:stroke-ember-400" : "stroke-slate-500/80 dark:stroke-slate-400/70"} strokeWidth={t / 5} strokeDasharray={`${t / 1.5} ${t / 2}`} />
              <line x1={s.hinge.x_mm} y1={s.hinge.y_mm} x2={s.open.x_mm} y2={s.open.y_mm} className="stroke-slate-600 dark:stroke-slate-300" strokeWidth={t / 2.5} strokeLinecap="round" />
            </g>
          );
        }),
      )}
    </svg>
  );
}

/** The SVG arc command from a door's leaf shut to its leaf open, about its
 *  hinge: what the plan and the print both draw. */
export function arcTo(s: DoorSwing): string {
  const sweep = cross(s.hinge, s.shut, s.open) > 0 ? 1 : 0;
  return ["A", s.leaf_mm, s.leaf_mm, 0, 0, sweep, s.open.x_mm, s.open.y_mm].join(" ");
}

/** Which way round the hinge the leaf turns from shut to open (the sign of
 *  the cross product): the arc's sweep flag. */
function cross(h: { x_mm: number; y_mm: number }, a: { x_mm: number; y_mm: number }, b: { x_mm: number; y_mm: number }): number {
  return (a.x_mm - h.x_mm) * (b.y_mm - h.y_mm) - (a.y_mm - h.y_mm) * (b.x_mm - h.x_mm);
}

/** While a box is dragged: the clear floor to the nearest thing or wall on
 *  each side, drawn as a line with its length, so racks can be set an aisle
 *  apart by eye. Gaps under a few mm (against a wall) are not drawn. */
export function GapReadout({ room, walls, box, others }: { room: { w_mm: number; d_mm: number }; walls: readonly PlanWall[]; box: PlanBox; others: readonly PlanItem[] }) {
  const gaps = gapsAround(box, [...others], { ...room, walls: [...walls] });
  const shown = (Object.entries(gaps) as Array<[string, Gap]>).filter(([, g]) => g.mm >= 5);
  const t = wallMm(room);
  return (
    <svg aria-hidden data-gap-readout="" className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible" viewBox={`0 0 ${room.w_mm} ${room.d_mm}`} preserveAspectRatio="none">
      {shown.map(([side, g]) => (
        <line key={side} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} className="stroke-accent" strokeWidth={t / 3} strokeDasharray={`${t} ${t / 2}`} />
      ))}
      {shown.map(([side, g]) => (
        <foreignObject key={`l${side}`} x={(g.x1 + g.x2) / 2 - t * 8} y={(g.y1 + g.y2) / 2 - t * 2} width={t * 16} height={t * 4} className="overflow-visible">
          <div className="flex h-full items-center justify-center">
            <span data-gap={side} data-gap-mm={g.mm} title={`${n(g.mm)} mm to ${g.to}`} className="rounded bg-accent px-1 font-mono text-[10px] leading-4 text-white shadow">
              {n(g.mm)}
            </span>
          </div>
        </foreignObject>
      ))}
    </svg>
  );
}

const FLAG_WORD: Record<PlanFlag["kind"], string> = { door: "Door", window: "Window", aisle: "Aisle" };

/** What the plan says is in the way, in words under the drawing: a door's
 *  swing first, then windows, then narrow aisles. Never a refusal. */
export function PlanFlagList({ flags }: { flags: readonly PlanFlag[] }) {
  if (flags.length === 0) return null;
  const order = { door: 0, window: 1, aisle: 2 } as const;
  return (
    <ul data-testid="plan-flags" className="mt-2 space-y-0.5 text-xs">
      {[...flags].sort((a, b) => order[a.kind] - order[b.kind]).map((f, i) => (
        <li key={i} data-plan-flag={f.kind} className={f.kind === "door" ? "font-medium text-ember-700 dark:text-ember-300" : "text-amber-800 dark:text-amber-300"}>
          <span className="text-content dark:text-slate-200">{FLAG_WORD[f.kind]}:</span> {f.text}
        </li>
      ))}
    </ul>
  );
}
