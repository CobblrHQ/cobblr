// "A or B", chosen: side-by-side rectangular buttons, the selected one filled
// (#5058). The one control for picking one of a FEW things; the browser's round
// radio input is not used anywhere in the product (lint:no-radio-inputs).
//
// Two to about five options. Past that it is a <select>, not a row of buttons
// (see SEGMENTED_MAX). It is a radiogroup for assistive tech: role=radiogroup,
// each button role=radio with aria-checked, one tab stop (the selected option),
// and the arrow keys move and select. Options wrap onto the next line on a
// phone rather than shrinking or scrolling sideways. The picked option carries
// a check mark as well as its fill, so it is told apart without its colour
// (#6045: Off / Just me / Share on a connection read by colour alone).

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { rovingRadio } from "./roving-radio";

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
  // Tab lands on the picked option, or the first one that can be picked.
  const picked = options.findIndex((o) => o.value === value && !o.disabled);
  const stop = picked >= 0 ? picked : options.findIndex((o) => !o.disabled);

  return (
    <div role="radiogroup" aria-label={label} className={`${stack ? "flex flex-col" : "flex flex-wrap"} gap-2 ${className}`}>
      {options.map((o, i) => {
        const picked = o.value === value;
        const off = disabled || !!o.disabled;
        const fill = o.tone === "danger" ? "border-ember-600 bg-ember-600 text-white" : "border-cobble-600 bg-cobble-600 text-white";
        return (
          <button
            key={o.value}
            {...rovingRadio(i, stop)}
            type="button"
            role="radio"
            aria-checked={picked}
            disabled={off}
            data-testid={o.testId}
            onClick={() => {
              if (!picked) onChange(o.value);
            }}
            className={
              "min-h-11 rounded-lg border px-3 py-1.5 text-left text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 " +
              (stack ? "w-full " : "") +
              (picked ? fill : "border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:border-cobble-400")
            }
          >
            <span className="flex items-center gap-1">
              {picked && <Check size={14} strokeWidth={2.5} aria-hidden data-picked-mark className="shrink-0" />}
              <span>{o.label}</span>
            </span>
            {o.hint && (
              <span className={"block text-[11px] font-normal " + (picked ? "text-white/85" : "text-muted dark:text-slate-400")}>{o.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
