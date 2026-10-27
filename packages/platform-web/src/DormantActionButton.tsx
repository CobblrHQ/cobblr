import { RecordActionItem } from "./RecordActionContributions";
// A door to what a record would do if a module that is off were on (#3883).
//
// Labels is off in a fresh workspace, and a record simply had no Print label:
// nothing on the page said the ability existed. The record now shows it,
// dashed and marked "off", and one tap says where it comes from and turns that
// module on (an owner or admin), then does the thing that was asked for; or
// asks the admins to (everyone else). It is never a button that runs while the
// module is off.
import { ActionDescription } from "./ActionDescription";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { usePlatformWeb } from "./context";
import { useToast } from "./ToastContext";
import { changeWorkspaceShape } from "./workspace-shape";
import type { PlatformDormantAction } from "./types";

export function DormantActionButton({
  entityKind,
  action,
  onTurnedOn,
}: {
  entityKind: string;
  action: PlatformDormantAction;
  /** The module is on: the bar's live button for this action runs it, and
   *  shows what came of it where the result outlives this door. */
  onTurnedOn: (actionId: string) => void;
}) {
  const { api, orgSlug, role } = usePlatformWeb();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const canTurnOn = !!api.enableModule && roleSatisfies(role ?? undefined, ["owner", "admin"]);
  const canAsk = !!api.askForModule;
  if (!canTurnOn && !canAsk) return null;

  const turnOn = async () => {
    setBusy(true);
    try {
      await changeWorkspaceShape(qc, orgSlug, () => api.enableModule!(orgSlug, action.module_name), { settled: true });
      toast.success(`${action.module_label} is on`);
      setOpen(false);
      // The thing that was asked for, now that it exists: the list read fresh,
      // so only an action the server now lists is run, by its own button.
      await qc.fetchQuery({
        queryKey: ["platform-actions", orgSlug, entityKind],
        queryFn: () => api.listActions(orgSlug, entityKind),
        staleTime: 0,
      });
      onTurnedOn(action.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const ask = async () => {
    setBusy(true);
    try {
      await api.askForModule!(orgSlug, action.module_name, action.module_label);
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <RecordActionItem id={action.id} group={action.group ?? "more"} primary={action.primary} label={action.label} description={action.description ?? `Turn on ${action.module_label} to use this.`}><ActionDescription description={action.description || action.label}><button
        type="button"
        data-dormant-action={action.id}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        title={`${action.label} comes with ${action.module_label}, which is off in this workspace`}
        className="rounded-md border border-dashed border-line dark:border-slate-600 text-xs px-2 py-1.5 text-faint hover:text-accent hover:border-accent transition flex items-center gap-1"
      >
        {action.label}
        <span className="rounded bg-subtle dark:bg-slate-800 px-1 text-[9px] normal-case tracking-normal">off</span>
      </button></ActionDescription>
      {/* The note goes where the door went: a door in a group menu drew its
          note in the bar, under the menu's backdrop, so the first tap on Turn
          on only closed the menu (#8648). */}
      {open && (
        <span
          role="dialog"
          aria-label={`${action.label} needs ${action.module_label}`}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 flex max-w-xs flex-col gap-1.5 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2 text-xs text-content dark:text-mortar-100 shadow-lg"
        >
          <span>
            {action.label} comes with <strong>{action.module_label}</strong>, which is off in this workspace.
          </span>
          {canTurnOn ? (
            <button type="button" disabled={busy} onClick={turnOn} className="self-start rounded-md bg-cobble-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-cobble-700 disabled:opacity-50">
              {busy ? "Turning on…" : `Turn on ${action.module_label}`}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={ask} className="self-start rounded-md border border-amber-500 bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-100 disabled:opacity-50">
              Ask an admin to turn it on
            </button>
          )}
        </span>
      )}</RecordActionItem>
    </>
  );
}
