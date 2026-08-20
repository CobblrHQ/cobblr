// Generic actions bar — drop onto any entity-detail page; renders
// platform-registered + user-bound actions for the kind.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { usePlatformWeb, useFlowHost } from "./context";
import { AskCobbAbout } from "./AskCobbAbout";
import { printDirectiveOf, runPrintDirective } from "./print-directive";
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
  const { api, orgSlug } = usePlatformWeb();
  const { openFlow } = useFlowHost();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [flash, setFlash] = useState<"ok" | "err" | null>(null);
  // Walk-up print feedback. Its own line rather than the flash chip, because
  // it lands a second or two later and says more than "done".
  const [note, setNote] = useState<string | null>(null);

  const invoke = useMutation({
    mutationFn: () =>
      api.invokeAction(orgSlug, { actionId: action.id, entityKind, entityId }),
    onSuccess: (data) => {
      setFlash("ok");
      setTimeout(() => setFlash(null), 1200);
      void qc.invalidateQueries({ queryKey: ["labels-queue"] });
      // An action result may carry a `ui` directive asking the shell to open a
      // first-party flow (e.g. disassemble → the organize planner over the
      // spawned parts). Honored generically; a flow this shell doesn't host is
      // a no-op. See docs/architecture/invokable-flows-and-lego-redesign.md.
      const ui = (data as { result?: { ui?: { flow?: string; args?: Record<string, unknown> } } })
        ?.result?.ui;
      if (ui && typeof ui.flow === "string") openFlow(ui.flow, ui.args ?? {});

      // …or a `ui.print` directive: "here is something printable". Only a
      // browser-driven printer needs the browser's help, since the server can
      // reach every other kind itself, so this is a no-op unless one is the
      // default. That is what lets a module return the directive every time
      // without knowing what hardware the workspace has.
      const directive = printDirectiveOf((data as { result?: unknown })?.result);
      if (directive && api.listPrinters && api.postToModulePath) {
        const listPrinters = api.listPrinters.bind(api);
        const post = api.postToModulePath.bind(api);
        void runPrintDirective(directive, {
          listPrinters: () => listPrinters(orgSlug),
          post: (path, body) => post(orgSlug, path, body),
        })
          .then((r) => {
            if (!r.printed) return;          // no browser printer: the queue still has it
            void qc.invalidateQueries({ queryKey: ["labels-queue"] });
            setNote(
              r.recordError
                ? "Printed, but the queue could not be updated. Refresh before printing again."
                : `Printed to ${r.deviceName}`,
            );
            setTimeout(() => setNote(null), 3000);
          })
          .catch((e: unknown) => {
            // It did NOT print. The row is still queued, so the fallback is
            // intact; say what went wrong rather than failing silently.
            setNote(e instanceof Error ? e.message : String(e));
            setTimeout(() => setNote(null), 5000);
          });
      }
    },
    onError: () => {
      setFlash("err");
      setTimeout(() => setFlash(null), 2400);
    },
  });

  function go() {
    if (action.invoke_handler) {
      invoke.mutate();
    } else if (action.invoke_route) {
      const r = action.invoke_route
        .replace("{entityKind}", encodeURIComponent(entityKind))
        .replace("{entityId}", encodeURIComponent(entityId));
      navigate(r);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          go();
        }}
        disabled={invoke.isPending}
        title={action.description ?? action.label}
        className={
          "rounded-md border text-[10px] font-mono uppercase tracking-widest px-2 py-1 transition flex items-center gap-1 " +
          (flash === "ok"
            ? "border-moss-200 bg-moss-50 text-moss-600"
            : flash === "err"
            ? "border-ember-200 bg-ember-50 text-ember-600"
            : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800/70 hover:text-accent dark:hover:text-cobble-300")
        }
      >
        {flash === "ok"
          ? "done"
          : flash === "err"
          ? "err"
          : invoke.isPending
          ? "…"
          : action.label}
      </button>
      {note && (
        <span className="self-center text-[10px] text-muted dark:text-slate-400">{note}</span>
      )}
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
  const { api, orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  const [flash, setFlash] = useState<"ok" | "err" | null>(null);
  const invoke = useMutation({
    mutationFn: () =>
      api.invokeAction(orgSlug, {
        actionId: binding.action_id,
        entityKind,
        entityId,
        bindingId: binding.binding_id,
      }),
    onSuccess: () => {
      setFlash("ok");
      setTimeout(() => setFlash(null), 1200);
      void qc.invalidateQueries({ queryKey: ["labels-queue"] });
    },
    onError: () => {
      setFlash("err");
      setTimeout(() => setFlash(null), 2400);
    },
  });
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        invoke.mutate();
      }}
      disabled={invoke.isPending}
      title={`${binding.label} (custom template)`}
      className={
        "rounded-md border text-[10px] font-mono uppercase tracking-widest px-2 py-1 transition flex items-center gap-1 " +
        (flash === "ok"
          ? "border-moss-200 bg-moss-50 text-moss-600"
          : flash === "err"
          ? "border-ember-200 bg-ember-50 text-ember-600"
          : "border-cobble-200 dark:border-cobble-700 text-accent dark:text-cobble-300 hover:bg-cobble-50 dark:hover:bg-slate-800/70")
      }
    >
      {flash === "ok"
        ? "done"
        : flash === "err"
        ? "err"
        : invoke.isPending
        ? "…"
        : binding.label}
    </button>
  );
}
