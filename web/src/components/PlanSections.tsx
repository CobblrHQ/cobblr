// A plan with several destinations, one section each, on the card that
// offers it. Each section says what goes where (its records as chips), and
// on the card each has its own Do this; Do all at the bottom runs the ones
// that have not, in order. A section that ran morphs in place: a check, the
// past-tense sentence the run came back with, its own Undo. One that failed
// says so in place and keeps its button. The offer strip (before the message
// is sent) draws the same sections read-only, above its one Do it.
//
// The card is one thing with several parts, not several cards: the owner's
// sentence was one sentence ("get all the other grocery/ spices out of
// inventory and into the dedicated sections"), and the answer to it is one
// card whose parts can be taken one at a time (2026-09-13).

import { Check, RotateCcw } from "lucide-react";
import type { PlanSectionOffer } from "../lib/api";
import { ChatRefChip } from "./ChatRefChip";

/** What one section's run came back with, kept on the message. */
export interface SectionRun {
  ok: boolean;
  /** The run's own sentence, past tense ("Moved 1 record into Groceries."). */
  message: string;
  ledgerIds: string[];
  undoable: boolean;
  undone?: boolean;
  undoResult?: string;
  undoOk?: boolean;
}

export type SectionRuns = Record<string, SectionRun>;

/** The sections that have not run, or ran and failed: what Do all does next. */
export function sectionsLeft(sections: PlanSectionOffer[], runs: SectionRuns | undefined): PlanSectionOffer[] {
  return sections.filter((s) => !runs?.[s.key]?.ok);
}

export function PlanSections({
  sections,
  runs,
  mode,
  tone = "neutral",
  slug,
  routeFor,
  onGo,
  onRun,
  onRunAll,
  onUndo,
  onCancel,
  busy = false,
  runningKey,
  undoingKey,
}: {
  sections: PlanSectionOffer[];
  runs?: SectionRuns;
  /** "offer": the strip before the message is sent, read-only. "card": the
   *  card in the reply, with the buttons. */
  mode: "offer" | "card";
  tone?: "neutral" | "green";
  slug: string;
  routeFor: (kind: string, id: string) => string | null;
  onGo: (to: string) => void;
  onRun?: (key: string) => void;
  onRunAll?: () => void;
  onUndo?: (key: string) => void;
  onCancel?: () => void;
  busy?: boolean;
  runningKey?: string | null;
  undoingKey?: string | null;
}) {
  const faint = tone === "green" ? "text-emerald-700/80 dark:text-emerald-400/70" : "text-muted dark:text-slate-400";
  const text = tone === "green" ? "text-emerald-800 dark:text-emerald-300" : "text-content dark:text-mortar-200";
  const left = sectionsLeft(sections, runs);
  const anyRan = sections.some((s) => !!runs?.[s.key]);
  return (
    <div className="mt-1 min-w-0 space-y-2">
      {sections.map((s) => {
        const run = runs?.[s.key];
        const done = !!run?.ok;
        return (
          <section key={s.key} aria-label={s.heading} className="min-w-0">
            <div className={`text-xs font-medium ${done ? faint : text} flex items-center gap-1.5`}>
              {done && <Check size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
              <span className={done ? "line-through decoration-1" : ""}>{s.heading}</span>
            </div>
            <ul className={`text-xs ${done ? faint : text} space-y-0.5`}>
              {s.lines.map((l) => {
                const href = l.kind ? routeFor(l.kind, l.id) : null;
                return (
                  <li key={l.id} className="flex gap-1.5 min-w-0">
                    <span className={`shrink-0 ${faint}`}>•</span>
                    <span className="min-w-0 break-words">
                      {href ? (
                        <ChatRefChip slug={slug} href={href} onGo={onGo}>
                          {l.title}
                        </ChatRefChip>
                      ) : (
                        l.title
                      )}
                      {/* Why it goes there, when that was the table's own
                          word and not the person's: "seasoning". */}
                      {l.why && <span className={faint}> · {l.why}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
            {s.note && <div className={`text-[11px] ${faint} break-words`}>{s.note}</div>}
            {/* What happened to this part: said where its button was, so the
                reader never matches sentences to buttons. */}
            {run && (
              <div className={`mt-0.5 text-[11px] ${run.ok ? faint : "text-ember-600 dark:text-ember-400"} break-words`} role="status">
                {(run.ok ? "✓ " : "✗ ") + run.message}
              </div>
            )}
            {run?.ok && run.undoResult && (
              <div className={`mt-0.5 text-[11px] ${run.undoOk ? faint : "text-ember-600 dark:text-ember-400"}`}>{(run.undoOk ? "↩ " : "✗ ") + run.undoResult}</div>
            )}
            {mode === "card" && (
              <div className="mt-1 flex items-center gap-2">
                {!done && onRun && (
                  <button
                    type="button"
                    onClick={() => onRun(s.key)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-medium px-2 py-0.5 transition disabled:opacity-50"
                  >
                    <Check size={12} /> {runningKey === s.key ? "Doing this…" : run && !run.ok ? "Try this again" : "Do this"}
                  </button>
                )}
                {done && run.undoable && !run.undone && !run.undoResult && onUndo && (
                  <button
                    type="button"
                    onClick={() => onUndo(s.key)}
                    disabled={busy || undoingKey === s.key}
                    className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:text-ember-500 hover:border-ember-400 text-[11px] font-medium px-2 py-0.5 transition disabled:opacity-50"
                  >
                    <RotateCcw size={11} /> {undoingKey === s.key ? "Putting back…" : "Undo"}
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
      {/* Do all counts what is left and goes when nothing is. Cancel stays
          until something ran: after that the card is a record of what did. */}
      {mode === "card" && left.length > 0 && (
        <div className="mt-1.5 flex items-center gap-2">
          {onRunAll && (
            <button
              type="button"
              onClick={onRunAll}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
            >
              <Check size={13} /> Do all {left.length}
            </button>
          )}
          {!anyRan && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-md border border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}
