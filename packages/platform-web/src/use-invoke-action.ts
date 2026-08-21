// Invoking one action on one record — the whole of it, once.
//
// This lived inside EntityActionsBar's ActionButton: the mutation, the flash,
// the `ui.flow` directive, the `ui.print` directive that hands a job to a
// browser-driven printer, and the cache invalidation. BindingButton, three
// hundred lines below it, had a shorter copy that did the mutation and the
// flash and dropped the rest — so a print the USER had bound (the whole point
// of a binding: "labels apply to everything physical") never reached a BLE or
// serial printer, while the module's own button did.
//
// One implementation, so a surface that invokes an action cannot accidentally
// implement three quarters of it. Rows use it too.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { usePlatformWeb, useFlowHost } from "./context";
import { printDirectiveOf, runPrintDirective } from "./print-directive";

export interface InvokeTarget {
  entityKind: string;
  entityId: string;
}

export interface RunArgs {
  actionId: string;
  /** Present when the user's own binding is what is being run. */
  bindingId?: string;
  /** A route-style action navigates instead of invoking. */
  invokeRoute?: string | null;
  invokeHandler?: string | null;
}

export function useInvokeEntityAction({ entityKind, entityId }: InvokeTarget) {
  const { api, orgSlug } = usePlatformWeb();
  const { openFlow } = useFlowHost();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [flash, setFlash] = useState<"ok" | "err" | null>(null);
  // Walk-up print feedback: its own line rather than the flash chip, because it
  // lands a second or two later and says more than "done".
  const [note, setNote] = useState<string | null>(null);

  const invoke = useMutation({
    mutationFn: (args: RunArgs) =>
      api.invokeAction(orgSlug, {
        actionId: args.actionId,
        entityKind,
        entityId,
        ...(args.bindingId ? { bindingId: args.bindingId } : {}),
      }),
    onSuccess: (data) => {
      setFlash("ok");
      setTimeout(() => setFlash(null), 1200);
      void qc.invalidateQueries({ queryKey: ["labels-queue"] });

      // A result may carry a `ui` directive asking the shell to open a
      // first-party flow (e.g. disassemble → the organize planner over the
      // spawned parts). Honored generically; a flow this shell doesn't host is
      // a no-op. See docs/architecture/invokable-flows-and-lego-redesign.md.
      const ui = (data as { result?: { ui?: { flow?: string; args?: Record<string, unknown> } } })?.result?.ui;
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
            if (!r.printed) return; // no browser printer: the queue still has it
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

  /** Invoke, or navigate when the action is a route rather than a handler. */
  function run(args: RunArgs): void {
    if (args.invokeHandler || args.bindingId) {
      invoke.mutate(args);
      return;
    }
    if (args.invokeRoute) {
      navigate(
        args.invokeRoute
          .replace("{entityKind}", encodeURIComponent(entityKind))
          .replace("{entityId}", encodeURIComponent(entityId)),
      );
    }
  }

  return { run, flash, note, pending: invoke.isPending };
}
