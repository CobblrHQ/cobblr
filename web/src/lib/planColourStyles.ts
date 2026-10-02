// How each plan colour is drawn, in both themes. The list itself is the
// contract's (plan-colours), so the swatch, the outline and the assistant's
// "make it red" are the same red.
import type { PlanColour } from "@cobblr/platform-contract/plan-colours";

export const PLAN_COLOUR_STYLE: Record<PlanColour, { border: string; swatch: string; text: string; label: string }> = {
  red: { border: "border-red-500 dark:border-red-400", swatch: "bg-red-500 dark:bg-red-400", text: "text-red-600 dark:text-red-400", label: "Red" },
  orange: { border: "border-orange-500 dark:border-orange-400", swatch: "bg-orange-500 dark:bg-orange-400", text: "text-orange-600 dark:text-orange-400", label: "Orange" },
  yellow: { border: "border-yellow-500 dark:border-yellow-300", swatch: "bg-yellow-400 dark:bg-yellow-300", text: "text-yellow-600 dark:text-yellow-300", label: "Yellow" },
  green: { border: "border-emerald-600 dark:border-emerald-400", swatch: "bg-emerald-600 dark:bg-emerald-400", text: "text-emerald-600 dark:text-emerald-400", label: "Green" },
  blue: { border: "border-sky-600 dark:border-sky-400", swatch: "bg-sky-600 dark:bg-sky-400", text: "text-sky-600 dark:text-sky-400", label: "Blue" },
  purple: { border: "border-violet-600 dark:border-violet-400", swatch: "bg-violet-600 dark:bg-violet-400", text: "text-violet-600 dark:text-violet-400", label: "Purple" },
  grey: { border: "border-slate-600 dark:border-slate-300", swatch: "bg-slate-600 dark:bg-slate-300", text: "text-slate-600 dark:text-slate-300", label: "Grey" },
};

/** The order groups of pins take the colours in: neighbours far apart in hue,
 *  so the first two groups on a drawer never read as one. */
export const GROUP_COLOURS: readonly PlanColour[] = ["blue", "orange", "green", "purple", "red", "yellow", "grey"];
