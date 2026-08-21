// A row that knows which record it is.
//
// The Cobb affordance used to live only in EntityActionsBar, which is a
// DETAIL-page component: it queries the registered actions for a kind, so
// putting it on 121 location rows would be 121 queries. The result was that
// every hand-rolled list — Locations being the one that got noticed — simply
// had no way to say "this one" to the assistant, and the fix that suggests
// itself is to paste the button into each page's own markup. That is the
// hardcoding this platform exists to avoid: the next list starts without it
// again, and nothing says so.
//
// So a page declares what a row IS, and the platform decides what belongs on
// it. Adding something to every record row in the product later — a second
// affordance, a keyboard target, a drop zone — happens HERE, once, rather than
// in every list that ever shipped.
//
// Cheap by construction: no queries, no per-row state. The marks are also what
// a selection or a drop can resolve against later, which is why they are data
// attributes rather than props held in a context.

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AskCobbAbout } from "./AskCobbAbout";
import { usePlatformWeb } from "./context";
import { useInvokeEntityAction } from "./use-invoke-action";
import type { PlatformActionBinding } from "./types";

export interface RecordRowProps {
  /** Entity kind id, e.g. "core-locations:location". */
  kind: string;
  id: string;
  /** What to call it in the chat chip. */
  label: string;
  className?: string;
  /** The page's own row content, including whatever controls it already has. */
  children: ReactNode;
  /** Where the platform's affordances sit relative to the page's own content.
   *  Default "end" — the right of the row, where action clusters already live. */
  affordances?: "end" | "none";
}

/** The attributes that mark a DOM row as a record. Exported so a page that
 *  cannot use the component (a table row, a canvas node) can still mark
 *  itself, and anything walking the DOM can find it. */
export function recordRowMarks(kind: string, id: string, label: string): Record<string, string> {
  return { "data-cobb-kind": kind, "data-cobb-id": id, "data-cobb-label": label };
}

export function RecordRow({ kind, id, label, className, children, affordances = "end" }: RecordRowProps) {
  return (
    <div {...recordRowMarks(kind, id, label)} className={className}>
      {children}
      {affordances === "end" && (
        <>
          {/* What the USER said belongs on this kind. A binding is an explicit
              choice ("labels apply to everything physical"), so it earns a place
              on the row; a module's registered-but-unbound action stays on the
              record's own page, where there is room to explain it. */}
          <RowBindings kind={kind} id={id} />
          {/* Always rendered, never hover-only: a control that appears on hover
              does not exist on a phone, and this list is used standing up. */}
          <AskCobbAbout kind={kind} id={id} label={label} />
        </>
      )}
    </div>
  );
}

/** Does firing this from a ROW deserve a second tap?
 *
 *  A row button sits under the thumb, beside a delete. An action the platform
 *  says cannot be put right asks once rather than firing on the way past;
 *  printing a label is the everyday case (nothing breaks, but a label comes out
 *  and someone has to bin it).
 *
 *  Unknown means CONFIRM, not fire. `undoable` is newer than the actions
 *  endpoint, so an api that predates it sends nothing at all, and during a
 *  rollout the two halves are briefly different ages — the safe reading of
 *  silence is "ask". */
export function rowActionNeedsConfirm(binding: { undoable?: boolean }): boolean {
  return binding.undoable !== true;
}

/** At most this many on a row. Past three the row stops being a row; the rest
 *  stay on the record's page, which lists every action it has. */
const ROW_ACTION_CAP = 3;

function RowBindings({ kind, id }: { kind: string; id: string }) {
  const { api, orgSlug } = usePlatformWeb();
  // The SAME query key the detail page's actions bar uses, so a hundred rows of
  // one kind share one request rather than making a hundred.
  const { data } = useQuery({
    queryKey: ["platform-actions", orgSlug, kind],
    queryFn: () => api.listActions(orgSlug, kind),
    staleTime: 60_000,
  });
  const bindings = (data?.bindings ?? []).slice(0, ROW_ACTION_CAP);
  if (bindings.length === 0) return null;
  return (
    <>
      {bindings.map((b) => (
        <RowActionButton key={b.binding_id} kind={kind} id={id} binding={b} />
      ))}
    </>
  );
}

function RowActionButton({ kind, id, binding }: { kind: string; id: string; binding: PlatformActionBinding }) {
  const { run, flash, note, pending } = useInvokeEntityAction({ entityKind: kind, entityId: id });
  const [armed, setArmed] = useState(false);
  const needsConfirm = rowActionNeedsConfirm(binding);
  // The module's own words, because only it knows what its action does. "Print
  // label" does not say whether paper comes out now or a line joins a queue;
  // "Queue a printable label for this entity" does, and it is already written.
  const explain = binding.description ?? binding.label;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (needsConfirm && !armed) {
            setArmed(true);
            setTimeout(() => setArmed(false), 3000);
            return;
          }
          setArmed(false);
          run({ actionId: binding.action_id, bindingId: binding.binding_id });
        }}
        disabled={pending}
        title={armed ? `${explain} - press again to confirm` : explain}
        className={
          "transition px-1 text-[10px] font-mono uppercase tracking-widest " +
          (flash === "ok"
            ? "text-moss-600"
            : flash === "err"
            ? "text-ember-500"
            : armed
            ? "text-accent font-semibold"
            : "text-faint hover:text-accent")
        }
      >
        {flash === "ok" ? "done" : flash === "err" ? "err" : pending ? "..." : armed ? "sure?" : binding.label}
      </button>
      {/* Whatever the action reports afterwards, in its own words: a label that
          reached a walk-up printer says "Printed to <printer>" a beat after the
          queue accepted it. Generic — the row never guesses what happened. */}
      {note && <span className="text-[10px] text-muted dark:text-slate-400">{note}</span>}
    </>
  );
}
