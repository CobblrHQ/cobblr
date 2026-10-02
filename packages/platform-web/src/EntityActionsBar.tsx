// Generic actions bar — drop onto any entity-detail page; renders
// platform-registered + user-bound actions for the kind.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import { useInvokeEntityAction } from "./use-invoke-action";
import { ActionOutcome } from "./ActionOutcome";
import { AskCobbAbout } from "./AskCobbAbout";
import { HEADER_ACTION_IDS } from "./RecordHeaderChips";
import { DormantActionButton } from "./DormantActionButton";
import { RecordDisposition } from "./RecordDisposition";
import type { PlatformAction, PlatformActionBinding } from "./types";

interface Props {
  /** What this record is called, for the "ask Cobb about it" chip. Without it
   *  the button still works; the chip just says the kind. */
  entityLabel?: string;
  entityKind: string;
  entityId: string;
  className?: string;
  /** Action IDs to hide for THIS specific entity instance. The
   *  platform's `appliesTo` predicate matches at the entity-KIND level
   *  (every `inventory:part` looks alike to it), so per-instance
   *  applicability — "disassemble only on a kit, not a plain brick" —
   *  must be decided by the owning page and passed down here. */
  excludeActionIds?: string[];
  /** The page renders <RecordHeaderChips> beside the title, so the Cobb chip
   *  and the label action live up there and this strip is verbs only. */
  headerChips?: boolean;
}

export function EntityActionsBar({ entityKind, entityId, entityLabel, className, excludeActionIds, headerChips }: Props) {
  const { api, orgSlug } = usePlatformWeb();
  const { data } = useQuery({
    queryKey: ["platform-actions", orgSlug, entityKind],
    queryFn: () => api.listActions(orgSlug, entityKind),
    staleTime: 60_000,
  });
  const rawActions = data?.items ?? [];
  const bindings = data?.bindings ?? [];
  // What an off module would add here: a door each, after the real actions.
  const dormant = (data?.dormant ?? []).filter((a) => !(excludeActionIds ?? []).includes(a.id));
  const excluded = new Set(excludeActionIds ?? []);
  // A user-invoked binding overrides the platform-registered action
  // (it carries the user's template). Suppress the raw button so we
  // don't render two side-by-side "Print label" buttons. Also drop
  // wire-only actions (user_invokable === false) — they exist for
  // wires to target on events, not to be clicked on a detail page —
  // and any action the page excluded for this instance.
  const overriddenActionIds = new Set(bindings.map((b) => b.action_id));
  const actions = rawActions.filter(
    (a) =>
      !overriddenActionIds.has(a.id) &&
      a.user_invokable !== false &&
      !excluded.has(a.id) &&
      // Already beside the title when the page has a header; showing it here
      // too would be the two-label-buttons problem this replaced.
      !(headerChips && HEADER_ACTION_IDS.has(a.id)),
  );
  // The header's Print label already runs the collection's own binding, so
  // the strip showing it too was the second identical button (#3591).
  const visibleBindings = bindings.filter(
    (b) => !excluded.has(b.action_id) && !(headerChips && HEADER_ACTION_IDS.has(b.action_id)),
  );
  // The Cobb button rides in the SAME cluster as the record's other actions,
  // and rides alone when there are none: a detail page with no actions is
  // still a record you might want to ask about, and it is the one place a
  // checkbox cannot say "this one" for you.
  const ask = headerChips ? null : <AskCobbAbout kind={entityKind} id={entityId} label={entityLabel ?? "this"} />;
  // Every registered action for a kind lands here, and a kind with a rich
  // module behind it registers a lot: a ball of yarn showed sixteen shouting
  // chips ("confirm a parcel is in hand", "draft a purchase order") above its
  // own fields (2026-09-02). The first few stay in the open; the rest wait
  // behind one chip that says how many there are. User-bound actions (the
  // person's own templates) count as the front of the list.
  const [showAll, setShowAll] = useState(false);
  // A door that turned its module on hands the action to the live button
  // that replaces it, which runs it once and keeps the outcome beside it. Run
  // from the door, the result would vanish as the door unmounts.
  const [armed, setArmed] = useState<string | null>(null);
  const arm = (id: string) => {
    setArmed(id);
    setShowAll(true);
  };
  const disarm = () => setArmed(null);
  const buttons = [
    ...visibleBindings.map((b) => <BindingButton key={`b:${b.binding_id}`} entityKind={entityKind} entityId={entityId} binding={b} runNow={armed === b.action_id} onRan={disarm} />),
    ...actions.map((a) => <ActionButton key={a.id} entityKind={entityKind} entityId={entityId} action={a} runNow={armed === a.id} onRan={disarm} />),
    ...dormant.map((a) => <DormantActionButton key={`off:${a.id}`} entityKind={entityKind} action={a} onTurnedOn={arm} />),
  ];
  // Sold, given away, thrown out: on every record whose kind can leave, placed
  // here so no record page has to remember it.
  const lifecycle = data?.lifecycle ? <RecordDisposition key="lifecycle" kind={entityKind} id={entityId} /> : null;
  if (buttons.length === 0) {
    return ask || lifecycle ? (
      <div className={`flex flex-wrap gap-2 ${className ?? ""}`}>
        {ask}
        {lifecycle}
      </div>
    ) : null;
  }
  const folded = !showAll && buttons.length > ACTIONS_IN_THE_OPEN + 1;
  const shown = folded ? buttons.slice(0, ACTIONS_IN_THE_OPEN) : buttons;
  return (
    <div className={`flex flex-wrap gap-2 ${className ?? ""}`}>
      {ask}
      {shown}
      {lifecycle}
      {folded && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          data-testid="actions-more"
          className="rounded border border-dashed border-line dark:border-slate-600 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide text-muted dark:text-slate-400 hover:text-accent hover:border-accent transition"
        >
          +{buttons.length - ACTIONS_IN_THE_OPEN} more
        </button>
      )}
    </div>
  );
}

/** How many action chips a record shows before the rest fold. Five reads as a
 *  toolbar; sixteen reads as a wall. */
const ACTIONS_IN_THE_OPEN = 5;

/** Runs `go` once when `runNow` turns true: the action a door just turned on. */
function useRunOnce(runNow: boolean | undefined, go: () => void, onRan: (() => void) | undefined) {
  const ran = useRef(false);
  useEffect(() => {
    if (!runNow || ran.current) return;
    ran.current = true;
    go();
    onRan?.();
  });
}

function ActionButton({
  entityKind,
  entityId,
  action,
  runNow,
  onRan,
}: {
  entityKind: string;
  entityId: string;
  action: PlatformAction;
  runNow?: boolean;
  onRan?: () => void;
}) {
  const { run, flash, note, failure, asking, dismissFailure, pending } = useInvokeEntityAction({ entityKind, entityId });
  // One press, whether a person made it or a door that just turned the module
  // on: the same arguments either way.
  const go = () => run({ actionId: action.id, label: action.label, argsSchema: action.args_schema, invokeRoute: action.invoke_route, invokeHandler: action.invoke_handler });
  useRunOnce(runNow, go, onRan);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          go();
        }}
        disabled={pending}
        title={action.description ?? action.label}
        className={
          "rounded-md border text-[10px] font-mono uppercase tracking-widest px-2 py-1 transition flex items-center gap-1 " +
          (flash === "ok"
            ? "border-moss-200 bg-moss-50 text-moss-600"
            : flash === "err"
            ? "border-ember-200 bg-ember-50 text-ember-600 dark:text-ember-400"
            : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800/70 hover:text-accent dark:hover:text-cobble-300")
        }
      >
        {flash === "ok" ? "done" : flash === "err" ? "err" : pending ? "…" : action.label}
      </button>
      <ActionOutcome note={note} failure={failure} onDismiss={dismissFailure} asking={asking} />
    </>
  );
}

function BindingButton({
  entityKind,
  entityId,
  binding,
  runNow,
  onRan,
}: {
  entityKind: string;
  entityId: string;
  binding: PlatformActionBinding;
  runNow?: boolean;
  onRan?: () => void;
}) {
  const { run, flash, note, failure, asking, dismissFailure, pending } = useInvokeEntityAction({ entityKind, entityId });
  const go = () => run({ actionId: binding.action_id, argsSchema: binding.args_schema, binding });
  useRunOnce(runNow, go, onRan);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          go();
        }}
        disabled={pending}
        title={binding.label}
        className={
          "rounded-md border text-[10px] font-mono uppercase tracking-widest px-2 py-1 transition flex items-center gap-1 " +
          (flash === "ok"
            ? "border-moss-200 bg-moss-50 text-moss-600"
            : flash === "err"
            ? "border-ember-200 bg-ember-50 text-ember-600 dark:text-ember-400"
            : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800/70 hover:text-accent dark:hover:text-cobble-300")
        }
      >
        {flash === "ok" ? "done" : flash === "err" ? "err" : pending ? "…" : binding.label}
      </button>
      <ActionOutcome note={note} failure={failure} onDismiss={dismissFailure} asking={asking} />
    </>
  );
}
