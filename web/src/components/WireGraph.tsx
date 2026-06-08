// A bipartite node-graph of the workspace's wires, drawn as plain SVG — source
// kinds on the left, actions on the right, one curved edge per wire. Click an
// edge to open that wire's detail/edit modal; hover to highlight + see the
// trigger. Deliberately dependency-free: an earlier @xyflow version crashed the
// whole SPA on React 19 (it reached into restructured React internals), so this
// is built from primitives — it can't introduce a React-version incompatibility
// and stays a few KB. Editing still lives in the composer; this is the
// "see how it all connects" view.
import { useMemo, useState } from "react";
import type { PlatformBinding } from "../lib/api";

const ROW_H = 54;
const NODE_W = 156;
const NODE_H = 30;
const PAD = 18;
const COL_GAP = 230;
const short = (id: string) => id.split(":")[1] ?? id;

export function WireGraph({
  bindings,
  onSelect,
}: {
  bindings: PlatformBinding[];
  onSelect: (b: PlatformBinding) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const g = useMemo(() => {
    const kinds = [...new Set(bindings.map((b) => b.source_kind))].sort();
    const actions = [...new Set(bindings.map((b) => b.action_id))].sort();
    const kindY = new Map(kinds.map((k, i) => [k, PAD + i * ROW_H]));
    const actionY = new Map(actions.map((a, i) => [a, PAD + i * ROW_H]));
    const leftX = PAD;
    const rightX = PAD + NODE_W + COL_GAP;
    const edges = bindings.map((b) => {
      const y1 = (kindY.get(b.source_kind) ?? 0) + NODE_H / 2;
      const y2 = (actionY.get(b.action_id) ?? 0) + NODE_H / 2;
      const x1 = leftX + NODE_W;
      const x2 = rightX;
      const mx = (x1 + x2) / 2;
      return { b, x1, y1, x2, y2, path: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` };
    });
    const width = rightX + NODE_W + PAD;
    const height = PAD * 2 + Math.max(kinds.length, actions.length, 1) * ROW_H;
    return { kinds, actions, kindY, actionY, leftX, rightX, edges, width, height };
  }, [bindings]);

  if (bindings.length === 0) {
    return <div className="text-xs text-faint dark:text-slate-500 italic">No wires to graph yet.</div>;
  }

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-auto max-h-[520px]">
      <svg
        width={g.width}
        height={g.height}
        viewBox={`0 0 ${g.width} ${g.height}`}
        className="min-w-full"
        style={{ fontFamily: "ui-monospace, monospace" }}
      >
        <defs>
          <marker id="wg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="fill-cobble-500" />
          </marker>
          <marker id="wg-arrow-off" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="fill-slate-400" />
          </marker>
        </defs>

        {/* edges (one per wire) */}
        {g.edges.map(({ b, path, x1, y1, x2, y2 }) => {
          const on = hover === b.id;
          const enabled = b.enabled;
          return (
            <g
              key={b.id}
              className="cursor-pointer"
              onClick={() => onSelect(b)}
              onMouseEnter={() => setHover(b.id)}
              onMouseLeave={() => setHover(null)}
            >
              {/* fat invisible hit area so the thin edge is easy to click */}
              <path d={path} fill="none" stroke="transparent" strokeWidth={14} />
              <path
                d={path}
                fill="none"
                className={enabled ? "stroke-cobble-500" : "stroke-slate-400 dark:stroke-slate-600"}
                strokeWidth={on ? 2.5 : 1.5}
                strokeOpacity={enabled ? (on ? 1 : 0.85) : 0.45}
                strokeDasharray={enabled ? undefined : "5 4"}
                markerEnd={`url(#${enabled ? "wg-arrow" : "wg-arrow-off"})`}
              />
              {on && (
                <text
                  x={(x1 + x2) / 2}
                  y={(y1 + y2) / 2 - 5}
                  textAnchor="middle"
                  className="fill-content dark:fill-mortar-200"
                  fontSize={9}
                >
                  {b.trigger_type}
                  {b.trigger_event ? ` · ${b.trigger_event}` : ""}
                  {b.target && b.target !== "self" ? " → linked" : ""}
                </text>
              )}
            </g>
          );
        })}

        {/* kind nodes (left) + action nodes (right) */}
        {g.kinds.map((k) => (
          <Node key={k} x={g.leftX} y={g.kindY.get(k) ?? 0} label={short(k)} kind />
        ))}
        {g.actions.map((a) => (
          <Node key={a} x={g.rightX} y={g.actionY.get(a) ?? 0} label={short(a)} />
        ))}
      </svg>
    </div>
  );
}

function Node({ x, y, label, kind }: { x: number; y: number; label: string; kind?: boolean }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={7}
        className={
          "fill-surface dark:fill-slate-800 " +
          (kind ? "stroke-cobble-400 dark:stroke-cobble-600" : "stroke-violet-400 dark:stroke-violet-700")
        }
        strokeWidth={1}
      />
      <text
        x={x + NODE_W / 2}
        y={y + NODE_H / 2 + 3}
        textAnchor="middle"
        fontSize={11}
        className={kind ? "fill-accent dark:fill-cobble-300" : "fill-violet-600 dark:fill-violet-300"}
      >
        {label.length > 20 ? label.slice(0, 19) + "…" : label}
      </text>
    </g>
  );
}
