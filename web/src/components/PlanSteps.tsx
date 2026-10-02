// The steps of one plan, on the card that asks for it: what one message asked
// for, in the order it runs, each saying what it touches and whether it can
// be undone. One Confirm under them runs them all (modules/core-ai/src/api/
// one-plan.ts says why).

import type { AiChatProposal } from "../lib/api";
import { PlanLines } from "./PlanLines";

type Step = Extract<AiChatProposal, { kind: "plan" }>["steps"][number];

/** What the step's own action says about putting it back. Unknown says
 *  nothing rather than guess. */
export function undoWords(undoable: boolean | null | undefined): string | null {
  if (undoable === true) return "Can be undone";
  if (undoable === false) return "Cannot be undone";
  return null;
}

export function PlanSteps({ steps }: { steps: Step[] }) {
  return (
    <ol className="mt-1.5 space-y-1.5" data-testid="plan-steps">
      {steps.map((s, i) => {
        const undo = undoWords(s.undoable);
        const lines = s.proposal.kind === "action" ? (s.proposal.plan?.lines ?? []) : s.proposal.kind === "file" ? (s.proposal.lines ?? []) : [];
        return (
          <li key={i} className="flex gap-2 min-w-0">
            <span className="shrink-0 mt-0.5 h-4 w-4 rounded-full bg-subtle dark:bg-slate-700 text-[10px] font-semibold text-content dark:text-mortar-200 flex items-center justify-center">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-xs font-medium text-content dark:text-mortar-100 break-words">{s.summary}</div>
              {lines.length > 0 && <PlanLines lines={lines} />}
              {undo && <div className={`text-[11px] ${s.undoable ? "text-muted dark:text-slate-400" : "text-amber-700 dark:text-amber-400"}`}>{undo}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
