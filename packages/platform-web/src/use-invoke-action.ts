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
// hook mounts <ActionOutcome> to show them (lint:action-outcome-shown). An
// Undo the action hands back is offered in a toast (offerUndo, #5812).

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { usePlatformWeb, useFlowHost } from "./context";
import { printDirectiveOf } from "./print-directive-of";
import { printNextStep, refusalKind, verdictOf } from "./action-outcome-compose";
import { offerUndo, runAction } from "./run-action";
import { useToast } from "./ToastContext";
import { useLater } from "./use-later";
import type { BindingAskEntry } from "@cobblr/platform-contract/binding-ask";
import { askBeforePress, pressAnswersToArgs, type ActionArgSpec } from "@cobblr/platform-contract/action-args";
import type { Asking } from "./AskBeforeRun";

export interface InvokeTarget {
  entityKind: string;
  entityId: string;
}

export interface RunArgs {
  actionId: string;
  /** The action's arguments, as listed with it (`args_schema`). Not optional:
   *  a surface that runs an action must say what it takes, so a required one
   *  the press does not carry is asked for first instead of meeting the
   *  door's refusal. LOG SERVICE fired bare everywhere for ten days (#3865). */
  argsSchema: Record<string, ActionArgSpec> | null | undefined;
  /** What the sheet's run button says, for a plain action. */
  label?: string;
  /** Present when a binding is what is being run: its id, and what it asks
   *  before it runs. The binding itself, not just its id, so no surface can
   *  run one without its question (AskBeforeRun). */
  binding?: { binding_id: string; label?: string; ask?: readonly BindingAskEntry[] | null; args?: unknown };
  /** The arguments this press adds (the answers to the binding's ask). */
  args?: Record<string, unknown>;
  /** A route-style action navigates instead of invoking. */
  invokeRoute?: string | null;
  invokeHandler?: string | null;
}

export function useInvokeEntityAction({ entityKind, entityId }: InvokeTarget) {
  const { api, orgSlug } = usePlatformWeb();
  const { openFlow } = useFlowHost();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [flash, setFlash] = useState<"ok" | "err" | null>(null);
  // Walk-up print feedback: its own line rather than the flash chip, because it
  // lands a second or two later and says more than "done".
  const [note, setNote] = useState<string | null>(null);
  // Why the last run did not happen, in the action's own words, until dismissed.
  const [failure, setFailure] = useState<string | null>(null);
  // Every clear-it-later below dies with the surface (use-later.ts, #3463).
  const later = useLater();

  const invoke = useMutation({
    // Through the one door (run-action.ts), which refreshes every query
    // showing the record's kind once the action is done.
    mutationFn: (args: RunArgs) =>
      runAction(api, qc, orgSlug, {
        actionId: args.actionId,
        entityKind,
        entityId,
        ...(args.binding ? { bindingId: args.binding.binding_id } : {}),
        ...(args.args && Object.keys(args.args).length ? { args: args.args } : {}),
      }),
    onSuccess: (data, args) => {
      setFailure(null);
      setFlash("ok");
      later.after("flash", 1200, () => setFlash(null));
      void qc.invalidateQueries({ queryKey: ["labels-queue"] });
      // The verdict is the handler's own sentence when it wrote one ("Queued,
      // 3 in the queue"); it stays until the next press or a later step
      // replaces it with something the person must do.
      const verdict = verdictOf((data as { result?: unknown })?.result, "");
      // The Undo the action handed back, offered where the person is looking:
      // Use one took one and its Undo came back unseen (#5812). The toast
      // carries the verdict, so the line below does not repeat it.
      const offered = offerUndo(toast, (b) => runAction(api, qc, orgSlug, b), data, { entityKind, entityId }, verdict || (args.label ? `${args.label}: done.` : undefined));
      if (verdict && !offered) {
        setNote(verdict);
        later.after("note", 6000, () => setNote((cur) => (cur === verdict ? null : cur)));
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
        // The printer drivers load with the first directive, not with every page.
        void import("./print-directive")
          .then(({ runPrintDirective }) =>
            runPrintDirective(directive, {
              listPrinters: () => listPrinters(orgSlug),
              post: (path, body) => post(orgSlug, path, body),
            }),
          )
          .then((r) => {
            if (r.printed) void qc.invalidateQueries({ queryKey: ["labels-queue"] });
            const next = printNextStep({ result: r });
            if (next && later.alive) {
              setNote((cur) => (cur ? `${cur}. ${next}` : next));
              later.after("note", 8000, () => setNote(null));
            }
          })
          .catch((e: unknown) => {
            const next = printNextStep({ error: e });
            if (next && later.alive) {
              setNote((cur) => (cur ? `${cur}. ${next}` : next));
              later.after("note", 8000, () => setNote(null));
            }
          });
      }
    },
    onError: (err: unknown) => {
      // api.invokeAction raises a refusal (`result.ok:false`) with the
      // handler's sentence, and an HTTP failure with the server's; either
      // way the words are here. A refusal stays until dismissed; a declined
      // answer (nothing to apply to, nothing changed) passes as a note, the
      // calm thing it is, never as a failure (#3141).
      const { kind, words } = refusalKind(err);
      if (kind === "declined") {
        setNote(words);
        later.after("note", 6000, () => setNote((cur) => (cur === words ? null : cur)));
        return;
      }
      setFailure(words);
      setFlash("err");
      later.after("flash", 2400, () => setFlash(null));
    },
  });

  // A binding that asks something first: held here until answered.
  const [asking, setAsking] = useState<Asking | null>(null);

  /** Invoke, or navigate when the action is a route rather than a handler.
   *  A press that must ask something first (a binding's questions, or an
   *  argument the action requires that the button does not carry) asks it
   *  in AskBeforeRun, and runs only once it is answered. */
  function run(args: RunArgs): void {
    const invokes = !!(args.invokeHandler || args.binding);
    const ask = invokes && !args.args ? askBeforePress(args.argsSchema, args.binding?.args ?? null, args.binding?.ask ?? []) : [];
    if (ask.length > 0) {
      setAsking({
        label: args.binding?.label ?? args.label ?? "Run",
        ask,
        submit: (answers) => {
          setAsking(null);
          invoke.mutate({ ...args, args: pressAnswersToArgs(ask, answers) });
        },
        cancel: () => setAsking(null),
      });
      return;
    }
    if (args.invokeHandler || args.binding) {
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

  return { run, flash, note, failure, asking, dismissFailure: () => setFailure(null), pending: invoke.isPending };
}
