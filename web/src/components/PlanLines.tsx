// Everything a change will touch, listed on the card that asks for it. See
// web/src/lib/fold-lines.ts.

import { useState } from "react";
import { foldLines } from "../lib/fold-lines";

export function PlanLines({ lines, tone = "neutral" }: { lines: string[]; tone?: "neutral" | "green" }) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  const { shown, hidden } = foldLines(lines, open);
  const text = tone === "green" ? "text-emerald-800 dark:text-emerald-300" : "text-content dark:text-mortar-200";
  const faint = tone === "green" ? "text-emerald-700/70 dark:text-emerald-400/60" : "text-muted dark:text-slate-400";
  return (
    <div className="mt-1">
      <ul className={`text-xs ${text} space-y-0.5 ${open ? "max-h-48 overflow-y-auto pr-1" : ""}`}>
        {shown.map((l, i) => (
          <li key={i} className="flex gap-1.5 min-w-0">
            <span className={`shrink-0 ${faint}`}>•</span>
            <span className="min-w-0 break-words">{l}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" onClick={() => setOpen(true)} className={`mt-0.5 text-[11px] underline-offset-2 hover:underline ${faint}`}>
          and {hidden} more
        </button>
      )}
      {open && lines.length > 6 && (
        <button type="button" onClick={() => setOpen(false)} className={`mt-0.5 text-[11px] underline-offset-2 hover:underline ${faint}`}>
          show fewer
        </button>
      )}
    </div>
  );
}
