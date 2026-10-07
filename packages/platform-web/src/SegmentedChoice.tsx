// "A or B", chosen: side-by-side rectangular buttons, the selected one filled
// (#5058). The one control for picking one of a FEW things; the browser's round
// radio input is not used anywhere in the product (lint:no-radio-inputs).
//
// Two to about five options. Past that it is a <select>, not a row of buttons
// (see SEGMENTED_MAX). It is a radiogroup for assistive tech: role=radiogroup,
// each button role=radio with aria-checked, one tab stop (the selected option),
// and the arrow keys move and select. Options wrap onto the next line on a
// phone rather than shrinking or scrolling sideways.

import { useRef, type KeyboardEvent, type ReactNode } from "react";

/** Beyond this many options a row of buttons is the wrong control. */
export const SEGMENTED_MAX = 5;

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** One line under the label saying what choosing it does. */
  hint?: ReactNode;
  disabled?: boolean;
  testId?: string;
  /** Tone of the selected fill: "danger" for a destructive pick. */
  tone?: "default" | "danger";
}

export function SegmentedChoice<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
  className = "",
  stack = false,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T | null | undefined;
  onChange: (next: T) => void;
  /** The group's accessible name ("Save to"). */
  label: string;
  disabled?: boolean;
  className?: string;
  /** One option per line (options that carry long hints), full width. */
  stack?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((o, i) => (!o.disabled && !disabled ? i : -1)).filter((i) => i >= 0);
  const current = options.findIndex((o) => o.value === value);
  // Roving tabindex: the selected option is the tab stop, else the first enabled one.
  const stop = current >= 0 && enabled.includes(current) ? current : (enabled[0] ?? -1);

  const move = (from: number, dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(from);
    const next = enabled[(at + dir + enabled.length) % enabled.length]!;
    refs.current[next]?.focus();
    onChange(options[next]!.value);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(i, -1);
    }
  };

  return (
    <div role="radiogroup" aria-label={label} className={`${stack ? "flex flex-col" : "flex flex-wrap"} gap-2 ${className}`}>
      {options.map((o, i) => {
        const picked = o.value === value;
        const off = disabled || !!o.disabled;
        const fill = o.tone === "danger" ? "border-ember-600 bg-ember-600 text-white" : "border-cobble-600 bg-cobble-600 text-white";
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={picked}
            tabIndex={i === stop ? 0 : -1}
            disabled={off}
            data-testid={o.testId}
            onClick={() => {
              if (!picked) onChange(o.value);
            }}
            onKeyDown={(e) => onKey(e, i)}
            className={
              "min-h-10 rounded-lg border px-3 py-1.5 text-left text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 " +
              (stack ? "w-full " : "") +
              (picked ? fill : "border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:border-cobble-400")
            }
          >
            <span className="block">{o.label}</span>
            {o.hint && (
              <span className={"block text-[11px] font-normal " + (picked ? "text-white/85" : "text-muted dark:text-slate-400")}>{o.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
