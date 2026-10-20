// One action on one record, as a small chip a page can drop anywhere: a
// toast, a row, a confirmation card.
//
// The record page renders every action through EntityActionsBar; this is the
// same invoke path (the shared hook: mutation, flow directive, print directive
// to a browser-driven printer) for ONE action the page names. Generic on
// purpose: the page passes the action id, so this layer never knows which
// modules exist. The first caller is the camera's "Added" toast offering
// "Print label" right after a thing is filed.
//
// It is an offer, never an act. And it renders nothing unless the action
// applies to this kind (the owning module is on and registered it), so a
// workspace without the module never sees a button that would fail. A binding
// the person made wins over the raw action, the precedence the bar keeps, so
// their template is what runs.

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { ActionDescription, ActionOutcome, useInvokeEntityAction, usePlatformWeb } from "@cobblr/platform-web";
import { askBeforePress } from "@cobblr/platform-contract/action-args";

export function EntityActionChip({
  entityKind,
  entityId,
  actionId,
  label,
  icon,
  doneLabel = "done",
}: {
  entityKind: string;
  entityId: string;
  actionId: string;
  label: string;
  icon?: ReactNode;
  doneLabel?: string;
}) {
  const { api, orgSlug } = usePlatformWeb();
  const { data } = useQuery({
    // Same key as the action bar, so the list is already cached on any page
    // that rendered one.
    queryKey: ["platform-actions", orgSlug, entityKind],
    queryFn: () => api.listActions(orgSlug, entityKind),
    staleTime: 60_000,
  });
  const { run, pending, note, failure, asking, flash, dismissFailure } = useInvokeEntityAction({ entityKind, entityId });
  const [sent, setSent] = useState(false);
  const binding = (data?.bindings ?? []).find((b) => b.action_id === actionId);
  const action = (data?.items ?? []).find((a) => a.id === actionId && a.user_invokable !== false);
  if (!binding && !action) return null;
  // A failure is not "done": the words stay, and dismissing them brings the
  // button back so the person can try again.
  if (sent && failure) {
    return (
      <ActionOutcome
        note={null}
        failure={failure}
        onDismiss={() => {
          dismissFailure();
          setSent(false);
        }}
        asking={null}
      />
    );
  }
  if (sent || flash === "ok") return <span className="text-xs opacity-80">{note ?? doneLabel}</span>;
  return (
    <>
    <ActionOutcome note={null} failure={null} onDismiss={dismissFailure} asking={asking} />
    <ActionDescription description={binding?.description || action?.description || label}>
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        // A press that asks first (the binding's question, or an argument
        // the action requires) is not sent until it is answered; the hook's
        // flash says when it was.
        const asks = askBeforePress(binding?.args_schema ?? action?.args_schema, binding?.args ?? null, binding?.ask ?? []);
        if (asks.length === 0) setSent(true);
        run(
          binding
            ? {
                actionId: binding.action_id,
                argsSchema: binding.args_schema ?? action?.args_schema,
                binding,
                invokeRoute: binding.invoke_route,
                invokeHandler: binding.invoke_handler ?? action?.invoke_handler ?? null,
              }
            : { actionId: action!.id, label, argsSchema: action!.args_schema, invokeRoute: action!.invoke_route, invokeHandler: action!.invoke_handler },
        );
      }}
      className="inline-flex items-center gap-1 rounded-md border border-[color-mix(in_srgb,currentColor_30%,transparent)] px-2 py-0.5 text-xs font-medium hover:bg-black/5 transition disabled:opacity-50"
    >
      {pending ? <Loader2 size={12} className="animate-spin" /> : icon}
      {label}
    </button>
    </ActionDescription>
    </>
  );
}
