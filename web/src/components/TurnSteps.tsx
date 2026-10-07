// What a turn did, kept under its answer (#5067). The list used to vanish the
// moment the answer arrived, so a step the person had watched fail was gone
// and the answer was the only account left, the account that had claimed the
// step worked. Collapsed when everything went through; open, with the reason
// under the failed step, when something did not.

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import type { TurnStep } from "../lib/chat-progress";

export function stepsLine(steps: TurnStep[]): string {
  const failed = steps.filter((s) => s.state === "failed").length;
  const n = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
  return failed ? `${n} · ${failed} failed` : n;
}

export function TurnSteps({ steps }: { steps: TurnStep[] }) {
  const anyFailed = steps.some((s) => s.state === "failed");
  const [open, setOpen] = useState(anyFailed);
  if (!steps.length) return null;
  return (
    <div className="mt-1.5" data-testid="turn-steps">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`inline-flex items-center gap-1 text-[11px] font-medium ${anyFailed ? "text-red-700 dark:text-red-400" : "text-muted dark:text-slate-400"} hover:underline`}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {stepsLine(steps)}
      </button>
      {open && (
        <ol className="mt-1 space-y-1">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-1.5 min-w-0 text-[11px]" data-state={s.state}>
              <span className="shrink-0 mt-px">
                {s.state === "failed" ? (
                  <X size={12} className="text-red-600 dark:text-red-400" aria-label="failed" />
                ) : (
                  <Check size={12} className="text-emerald-600 dark:text-emerald-400" aria-label="done" />
                )}
              </span>
              <div className="min-w-0">
                <div className={`break-words ${s.state === "failed" ? "text-red-800 dark:text-red-300" : "text-content dark:text-mortar-200"}`}>{s.text}</div>
                {s.state === "failed" && s.why && <div className="break-words text-muted dark:text-slate-400">{s.why}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
