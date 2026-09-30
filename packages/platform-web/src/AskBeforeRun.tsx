// What a button asks before it runs, in one small sheet over the page: a
// collection's own question ("Open a bottle" asks for a tasting note), and any
// argument the action requires that the button does not carry ("Log service"
// asks what was done). Every surface that runs an action gets it through
// ActionOutcome, so a question is asked wherever the button is: a record's
// strip, its header, a list row.
//
// A collection's own question is never required: an empty answer runs the
// action without it, because a shortcut that cannot be pressed without typing
// is not one. An argument the action requires is, and the run button waits
// for it (pressStillNeeds), so what the sheet sends is never refused (#3865).

import { useState } from "react";
import { pressStillNeeds, type PressAsk } from "@cobblr/platform-contract/action-args";
import { Modal } from "./Modal";
import { isShortcut } from "./shortcuts";

export interface Asking {
  /** The button's label, which is also what the sheet's run button says. */
  label: string;
  ask: readonly PressAsk[];
  submit: (answers: Record<string, string>) => void;
  cancel: () => void;
}

export function AskBeforeRun({ asking }: { asking: Asking | null }) {
  if (!asking) return null;
  return <AskSheet asking={asking} />;
}

function AskSheet({ asking }: { asking: Asking }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const needs = pressStillNeeds(asking.ask, answers);
  const submit = () => {
    if (needs.length === 0) asking.submit(answers);
  };
  return (
    <Modal open onClose={asking.cancel} title={asking.label} size="sm">
      <form
        data-testid="ask-before-run"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          submit();
        }}
        onClick={(e) => e.stopPropagation()}
        className="space-y-3"
      >
        {asking.ask.map((q, i) => {
          const common = {
            id: `ask-${q.arg}`,
            name: q.arg,
            value: answers[q.arg] ?? "",
            placeholder: q.placeholder ?? "",
            autoFocus: i === 0,
            className:
              "w-full rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-2 text-base text-content dark:text-slate-100",
          };
          return (
            <label key={q.arg} htmlFor={common.id} className="block space-y-1">
              <span className="text-sm text-muted dark:text-slate-400">
                {q.label}
                {q.required ? <span className="text-ember-600 dark:text-ember-400"> *</span> : null}
              </span>
              {q.kind === "choice" ? (
                <select id={common.id} name={common.name} value={common.value} autoFocus={common.autoFocus} className={common.className} onChange={(e) => setAnswers((a) => ({ ...a, [q.arg]: e.target.value }))}>
                  <option value="">Choose</option>
                  {(q.choices ?? []).map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              ) : q.kind === "boolean" ? (
                <select id={common.id} name={common.name} value={common.value} autoFocus={common.autoFocus} className={common.className} onChange={(e) => setAnswers((a) => ({ ...a, [q.arg]: e.target.value }))}>
                  <option value="">Choose</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : q.kind === "date" ? (
                <input {...common} type="date" onChange={(e) => setAnswers((a) => ({ ...a, [q.arg]: e.target.value }))} />
              ) : q.kind === "number" ? (
                <input {...common} type="number" inputMode="decimal" onChange={(e) => setAnswers((a) => ({ ...a, [q.arg]: e.target.value }))} />
              ) : (
                <textarea
                  {...common}
                  rows={3}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.arg]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (isShortcut(e, "run")) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
              )}
            </label>
          );
        })}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={asking.cancel} className="rounded-md px-3 py-2 text-sm text-muted hover:text-content">
            Cancel
          </button>
          <button
            type="submit"
            data-testid="ask-before-run-go"
            disabled={needs.length > 0}
            title={needs.length > 0 ? `Needs ${needs.join(", ")}` : undefined}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {asking.label}
          </button>
        </div>
      </form>
    </Modal>
  );
}
