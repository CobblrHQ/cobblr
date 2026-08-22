// Generic actions bar — drop onto any entity-detail page; renders
// platform-registered + user-bound actions for the kind.

import { useQuery } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import { useInvokeEntityAction } from "./use-invoke-action";
import { AskCobbAbout } from "./AskCobbAbout";
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
}

export function EntityActionsBar({ entityKind, entityId, entityLabel, className, excludeActionIds }: Props) {
  const { api, orgSlug } = usePlatformWeb();
  const { data } = useQuery({
    queryKey: ["platform-actions", orgSlug, entityKind],
    queryFn: () => api.listActions(orgSlug, entityKind),
    staleTime: 60_000,
  });
  const rawActions = data?.items ?? [];
  const bindings = data?.bindings ?? [];
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
      !excluded.has(a.id),
  );
  const visibleBindings = bindings.filter((b) => !excluded.has(b.action_id));
  // The Cobb button rides in the SAME cluster as the record's other actions,
  // and rides alone when there are none: a detail page with no actions is
  // still a record you might want to ask about, and it is the one place a
  // checkbox cannot say "this one" for you.
  const ask = <AskCobbAbout kind={entityKind} id={entityId} label={entityLabel ?? "this"} />;
  if (actions.length === 0 && visibleBindings.length === 0) {
    return <div className={`flex flex-wrap gap-2 ${className ?? ""}`}>{ask}</div>;
  }
  return (
    <div className={`flex flex-wrap gap-2 ${className ?? ""}`}>
      {ask}
      {actions.map((a) => (
        <ActionButton
          key={a.id}
          entityKind={entityKind}
          entityId={entityId}
          action={a}
        />
      ))}
      {visibleBindings.map((b) => (
        <BindingButton
          key={b.binding_id}
          entityKind={entityKind}
          entityId={entityId}
          binding={b}
        />
      ))}
    </div>
  );
}

function ActionButton({
  entityKind,
  entityId,
  action,
}: {
  entityKind: string;
  entityId: string;
  action: PlatformAction;
}) {
  const { run, flash, note, pending } = useInvokeEntityAction({ entityKind, entityId });

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          run({ actionId: action.id, invokeRoute: action.invoke_route, invokeHandler: action.invoke_handler });
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
      {note && <span className="self-center text-[10px] text-muted dark:text-slate-400">{note}</span>}
    </>
  );
}

function BindingButton({
  entityKind,
  entityId,
  binding,
}: {
  entityKind: string;
  entityId: string;
  binding: PlatformActionBinding;
}) {
  const { run, flash, note, pending } = useInvokeEntityAction({ entityKind, entityId });
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          run({ actionId: binding.action_id, bindingId: binding.binding_id });
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
      {note && <span className="self-center text-[10px] text-muted dark:text-slate-400">{note}</span>}
    </>
  );
}
