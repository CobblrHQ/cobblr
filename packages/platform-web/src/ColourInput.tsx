// The colour picker every colour field uses: one colour by default, and
// "+ add colour" for a gradient or a multi-colour thing (a dual-colour silk
// spool, a variegated yarn), 2 to 4 colours, reordered with the arrows and
// drawn as a blend or as segments. The value is the one stored string
// (`#rrggbb`, `gradient(...)`, `multi(...)`; colour.ts), so every caller keeps
// its own commit path. A picker drag previews each tick and commits once on
// release (DragInput); adding, removing, reordering and the style commit at
// once, since each is one click.

import { ArrowLeft, ArrowRight, Plus, X } from "lucide-react";
import { formatColour, MAX_COLOURS, parseColour, type ColourSpec } from "@cobblr/platform-contract/colour";
import { DragInput } from "./DragInput";
import { Swatch } from "./Swatch";

export function ColourInput({
  value,
  onPreview,
  onCommit,
  label,
  compact = false,
}: {
  value: unknown;
  /** Every tick of a picker drag: the value to show, never a save. */
  onPreview?: (next: string) => void;
  /** The new stored value, once per change the person makes. */
  onCommit: (next: string) => void;
  /** The field's label, for the pickers' names. */
  label: string;
  /** A table cell: smaller pickers. */
  compact?: boolean;
}) {
  const spec: ColourSpec = parseColour(value) ?? { style: "solid", colours: ["#cccccc"] };
  const set = (next: ColourSpec) => onCommit(formatColour(next));
  const withColour = (i: number, hex: string) => {
    const next = [...colours];
    next[i] = hex;
    return formatColour({ style: many ? style : "solid", colours: next });
  };
  const colours = spec.colours;
  const many = colours.length > 1;
  const style = spec.style === "solid" ? "gradient" : spec.style;
  const move = (i: number, by: number) => {
    const next = [...colours];
    const [c] = next.splice(i, 1);
    next.splice(i + by, 0, c!);
    set({ style, colours: next });
  };
  const pick = compact ? "h-6 w-8" : "h-9 w-12";
  const icon = "w-7 h-7 grid place-items-center rounded text-muted hover:text-accent disabled:opacity-30";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="colour-input">
      {colours.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          <DragInput
            control="color"
            value={c}
            onPreview={(hex) => onPreview?.(withColour(i, hex))}
            onCommit={(hex) => onCommit(withColour(i, hex))}
            className={`${pick} shrink-0 rounded border border-line dark:border-slate-600 cursor-pointer bg-transparent p-0.5`}
            aria-label={many ? `${label} colour ${i + 1}` : `${label} colour picker`}
          />
          {many && (
            <>
              <button title={`Move colour ${i + 1} earlier`} type="button" className={icon} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move colour ${i + 1} earlier`}>
                <ArrowLeft size={12} />
              </button>
              <button title={`Move colour ${i + 1} later`} type="button" className={icon} disabled={i === colours.length - 1} onClick={() => move(i, 1)} aria-label={`Move colour ${i + 1} later`}>
                <ArrowRight size={12} />
              </button>
              <button
                title={`Remove colour ${i + 1}`}
                type="button"
                className={icon}
                onClick={() => set({ style: colours.length - 1 > 1 ? style : "solid", colours: colours.filter((_, j) => j !== i) })}
                aria-label={`Remove colour ${i + 1}`}
              >
                <X size={12} />
              </button>
            </>
          )}
        </span>
      ))}
      {colours.length < MAX_COLOURS && (
        <button
          type="button"
          onClick={() => set({ style, colours: [...colours, colours[colours.length - 1] ?? "#cccccc"] })}
          className="inline-flex items-center gap-0.5 text-xs text-accent hover:underline"
        >
          <Plus size={12} /> add colour
        </button>
      )}
      {many && (
        <span className="inline-flex rounded-md border border-line dark:border-slate-600 overflow-hidden text-xs" role="group" aria-label={`${label} style`}>
          {(["gradient", "multi"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={style === s}
              onClick={() => set({ style: s, colours })}
              className={`px-2 py-0.5 ${style === s ? "bg-cobble-600 text-white" : "text-muted"}`}
            >
              {s === "gradient" ? "Gradient" : "Segments"}
            </button>
          ))}
        </span>
      )}
      {many && <Swatch value={formatColour({ style, colours })} className={compact ? "w-10 h-4 rounded" : "w-16 h-5 rounded"} />}
    </span>
  );
}
