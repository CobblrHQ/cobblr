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
import { useInvokeEntityAction, usePlatformWeb } from "@cobblr/platform-web";

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
  const { run, pending, note } = useInvokeEntityAction({ entityKind, entityId });
  const [sent, setSent] = useState(false);
  const binding = (data?.bindings ?? []).find((b) => b.action_id === actionId);
  const action = (data?.items ?? []).find((a) => a.id === actionId && a.user_invokable !== false);
  if (!binding && !action) return null;
  if (sent) return <span className="text-xs opacity-80">{note ?? doneLabel}</span>;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setSent(true);
        run(
          binding
            ? {
                actionId: binding.action_id,
                bindingId: binding.binding_id,
                invokeRoute: binding.invoke_route,
                invokeHandler: binding.invoke_handler ?? action?.invoke_handler ?? null,
              }
            : { actionId: action!.id, invokeRoute: action!.invoke_route, invokeHandler: action!.invoke_handler },
        );
      }}
      className="inline-flex items-center gap-1 rounded-md border border-current/30 px-2 py-0.5 text-xs font-medium hover:bg-black/5 transition disabled:opacity-50"
    >
      {pending ? <Loader2 size={12} className="animate-spin" /> : icon}
      {label}
    </button>
  );
}
