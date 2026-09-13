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
//
// A failure is a sentence, kept. The chip used to flash "err" for 2.4s and
// drop the reason; the reason was "no label base URL is set ... set one under
// Configuration", which nobody read (#2847). `failure` holds the action's own
// words (a refusal's `result.error`, a thrown handler's message, the network's
// sentence) until the person dismisses them, and every surface that uses this
// hook mounts <ActionOutcome> to show them (lint:action-outcome-shown).

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { usePlatformWeb, useFlowHost } from "./context";
import { printDirectiveOf, runPrintDirective } from "./print-directive";
import { printNextStep, verdictOf } from "./action-outcome-compose";
import { runAction } from "./run-action";

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
  // Why the last run did not happen, in the action's own words, until dismissed.
  const [failure, setFailure] = useState<string | null>(null);

  const invoke = useMutation({
    // Through the one door (run-action.ts), which refreshes every query
    // showing the record's kind once the action is done.
    mutationFn: (args: RunArgs) =>
      runAction(api, qc, orgSlug, {
        actionId: args.actionId,
        entityKind,
        entityId,
        ...(args.bindingId ? { bindingId: args.bindingId } : {}),
      }),
    onSuccess: (data) => {
      setFailure(null);
      setFlash("ok");
      setTimeout(() => setFlash(null), 1200);
      void qc.invalidateQueries({ queryKey: ["labels-queue"] });
      // The verdict is the handler's own sentence when it wrote one ("Queued,
      // 3 in the queue"); it stays until the next press or a later step
      // replaces it with something the person must do.
      const verdict = verdictOf((data as { result?: unknown })?.result, "");
      if (verdict) {
        setNote(verdict);
        setTimeout(() => setNote((cur) => (cur === verdict ? null : cur)), 6000);
      }

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
        // Printing is a readiness question the action already answered
        // for itself (the queue holds the label). The second line, when
        // there is one, is the next step for the person, never an error
        // over the verdict; a workspace with no walk-up printer intent
        // (no Print module, no default) gets the verdict alone (#2884).
        void runPrintDirective(directive, {
          listPrinters: () => listPrinters(orgSlug),
          post: (path, body) => post(orgSlug, path, body),
        })
          .then((r) => {
            if (r.printed) void qc.invalidateQueries({ queryKey: ["labels-queue"] });
            const next = printNextStep({ result: r });
            if (next) {
              setNote((cur) => (cur ? `${cur}. ${next}` : next));
              setTimeout(() => setNote(null), 8000);
            }
          })
          .catch((e: unknown) => {
            const next = printNextStep({ error: e });
            if (next) {
              setNote((cur) => (cur ? `${cur}. ${next}` : next));
              setTimeout(() => setNote(null), 8000);
            }
          });
      }
    },
    onError: (err: unknown) => {
      // api.invokeAction raises a refusal (`result.ok:false`) with the
      // handler's sentence, and an HTTP failure with the server's; either
      // way the words are here, and they stay.
      setFailure(err instanceof Error && err.message.trim() ? err.message : "That action couldn't run.");
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

  return { run, flash, note, failure, dismissFailure: () => setFailure(null), pending: invoke.isPending };
}
