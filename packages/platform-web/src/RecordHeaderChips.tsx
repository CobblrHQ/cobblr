// The two things that sit BESIDE a record's title: its label, and Cobb.
//
// Neither is a verb about the record. "Print label" is about the sticker, and
// Cobb's head is about the conversation, so both were noise in the strip of
// things you can DO to the record, and the strip is where they lived (with
// Cobb at the front of every one). They sit up by the code chip now, where an
// item's identity is, and the strip below is left to its verbs.
//
// Placed by the platform, not the page: a page says "this record has a header"
// and the platform decides what a header carries, so adding a third thing here
// later happens in one file (lint:platform-affordances holds that line).
//
// The label button is the labels module's own `labels:print` action, found the
// same way the strip finds everything. Inventory used to ship a hand-rolled
// "QR label" button that called the labels module's routes by URL and did the
// same job; two doors to one label queue, one of them a module reaching into
// another (audit, 2026-09-08).

import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { usePlatformWeb } from "./context";
import { useInvokeEntityAction } from "./use-invoke-action";
import { ActionOutcome } from "./ActionOutcome";
import { AskCobbAbout } from "./AskCobbAbout";

/** The action whose chip lives up here rather than in the strip. */
export const HEADER_ACTION_IDS: ReadonlySet<string> = new Set(["labels:print"]);

export function RecordHeaderChips({
  kind,
  id,
  label,
  className,
}: {
  kind: string;
  id: string;
  /** What a person calls it, for the Cobb chip's title. */
  label: string;
  className?: string;
}) {
  const { api, orgSlug } = usePlatformWeb();
  // Same query key as the strip, so the two share one fetch.
  const { data } = useQuery({
    queryKey: ["platform-actions", orgSlug, kind],
    queryFn: () => api.listActions(orgSlug, kind),
    staleTime: 60_000,
  });
  const print = (data?.items ?? []).find((a) => HEADER_ACTION_IDS.has(a.id) && a.user_invokable !== false);
  return (
    <span className={`inline-flex items-center gap-1.5 ${className ?? ""}`}>
      {print && <PrintChip kind={kind} id={id} action={print} />}
      <AskCobbAbout kind={kind} id={id} label={label} />
    </span>
  );
}

function PrintChip({
  kind,
  id,
  action,
}: {
  kind: string;
  id: string;
  action: { id: string; label: string; description: string | null; invoke_route: string | null; invoke_handler: string | null };
}) {
  const { run, flash, failure, dismissFailure, note, pending } = useInvokeEntityAction({ entityKind: kind, entityId: id });
  return (
    <>
    <button
      type="button"
      disabled={pending}
      title={action.description ?? action.label}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        run({ actionId: action.id, invokeRoute: action.invoke_route, invokeHandler: action.invoke_handler });
      }}
      className={
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-widest transition " +
        (flash === "ok"
          ? "border-moss-200 bg-moss-50 text-moss-600"
          : flash === "err"
            ? "border-ember-200 bg-ember-50 text-ember-600 dark:text-ember-400"
            : "border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:text-accent hover:border-accent")
      }
    >
      <Printer size={10} />
      {flash === "ok" ? "queued" : flash === "err" ? "err" : pending ? "…" : action.label}
    </button>
    <ActionOutcome note={note} failure={failure} onDismiss={dismissFailure} />
    </>
  );
}
