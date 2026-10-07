import { useEscapeToClose } from "./useEscapeToClose";
import { createPortal } from "react-dom";
import { BackdropLayer, PopoverLayer } from "./fixed-layers";
import { groupRecordActions } from "@cobblr/platform-contract/action-groups";
import { RecordActionProvider, RecordActionItem, RecordActionSlot, useRecordActionContributions, type RecordActionDescriptor } from "./RecordActionContributions";
import { Modal } from "./Modal";
import { useToast } from "./ToastContext";
// Generic actions bar — drop onto any entity-detail page; renders
// platform-registered + user-bound actions for the kind.

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import { useInvokeEntityAction } from "./use-invoke-action";
import { ActionDescription, firstActionSentence } from "./ActionDescription";
import { ActionOutcome } from "./ActionOutcome";
import { AskCobbAbout } from "./AskCobbAbout";
import { HEADER_ACTION_IDS } from "./RecordHeaderChips";
import { DormantActionButton } from "./DormantActionButton";
import { RecordDisposition } from "./RecordDisposition";
import { RecordSharing } from "./RecordSharing";
import { RecordPublic } from "./RecordPublic";
import { SendRecords } from "./SendRecords";
import { RecordSendBack } from "./RecordSendBack";
import { RecordSuggestions } from "./RecordSuggestions";
import { RecordShareNote } from "./RecordShareNote";
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
  /** Menu defaults for a page; saved primary and pin choices take precedence. */
  overflowActionIds?: string[];
}

export function EntityActionsBar({ entityKind, entityId, entityLabel, className, excludeActionIds, headerChips, overflowActionIds }: Props) {
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
  const surface = useRecordActionContributions();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [sheet, setSheet] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEscapeToClose(!!open, panel, () => setOpen(null));
  const menuDefaults = Object.fromEntries((overflowActionIds ?? []).filter((id) => data?.pins?.[id] === undefined && data?.layout?.actions[id]?.primary === undefined).map((id) => [id, false]));
  const { primaries, menus } = groupRecordActions(surface.items, data?.layout, { ...menuDefaults, ...data?.pins });
  const pin = async (item: RecordActionDescriptor, pinned: boolean) => {
    try {
      await api.setRecordActionPin!(orgSlug, entityKind, item.id, pinned);
      await qc.invalidateQueries({ queryKey: ["platform-actions", orgSlug, entityKind] });
    } catch (e) { toast.error((e as Error).message); }
  };
  const entry = (item: RecordActionDescriptor, primary = false) => (
    <div key={item.id} className={primary ? "flex items-center gap-1" : "rounded-lg p-2 hover:bg-subtle"}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><RecordActionSlot id={item.id} /></div>
        {api.setRecordActionPin && <details className="relative shrink-0">
          <summary className="cursor-pointer list-none rounded px-2 py-1 text-muted" aria-label={`Options for ${item.label}`}>⋯</summary>
          <button type="button" className="absolute right-0 z-10 w-36 rounded-lg border border-line bg-surface p-2 text-left text-xs shadow-lg" onClick={() => void pin(item, !primary)}>{primary ? "Unpin from the bar" : "Pin to the bar"}</button>
        </details>}
      </div>
      {!primary && item.description && <p className="mt-1 text-xs text-muted">{firstActionSentence(item.description)}</p>}
    </div>
  );
  return (
    <RecordActionProvider value={surface}>
      <div ref={bar} data-testid="record-actions-bar" className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
        <RecordSuggestions kind={entityKind} id={entityId} />
        <RecordShareNote kind={entityKind} id={entityId} />
        {ask}
        {visibleBindings.map((b) => <BindingButton key={`b:${b.binding_id}`} entityKind={entityKind} entityId={entityId} binding={{ ...b, description: b.description || rawActions.find((a) => a.id === b.action_id)?.description }} runNow={armed === b.action_id} onRan={() => setArmed(null)} />)}
        {actions.map((a) => <ActionButton key={a.id} entityKind={entityKind} entityId={entityId} action={a} runNow={armed === a.id} onRan={() => setArmed(null)} />)}
        {dormant.map((a) => <DormantActionButton key={`off:${a.id}`} entityKind={entityKind} action={a} onTurnedOn={setArmed} />)}
        {data?.lifecycle && <RecordDisposition kind={entityKind} id={entityId} />}
        <RecordSharing kind={entityKind} id={entityId} />
        <RecordPublic id={entityId} />
        <SendRecords kind={entityKind} ids={[entityId]} record />
        <RecordSendBack kind={entityKind} id={entityId} />
        {primaries.map((item) => entry(item, true))}
        {menus.map((group) => (
          <div key={group.id} className="relative hidden sm:block">
            <button type="button" data-testid="record-action-group" aria-expanded={open === group.id} aria-controls={`record-menu-${entityId}-${group.id}`} onClick={(e) => { setAnchor(e.currentTarget.getBoundingClientRect()); setOpen(open === group.id ? null : group.id); }} className="inline-flex items-center gap-1 rounded border border-line bg-surface px-3 py-1.5 text-xs text-content hover:border-accent">
              {group.label} ▾{group.items.some((a) => a.badge) && <span className="text-muted"> · {group.items.map((a) => a.badge).filter(Boolean).join(" · ")}</span>}
            </button>
            {open === group.id && anchor && createPortal(<><BackdropLayer className="z-[60]" onClick={() => setOpen(null)} /><PopoverLayer ref={panel} style={{ left: anchor.left, top: anchor.bottom + 6, width: 320 }} flipAbove={anchor.top} id={`record-menu-${entityId}-${group.id}`} role="region" aria-label={`${group.label} actions`} className="z-[61] max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg">{group.items.map((item) => entry(item))}</PopoverLayer></>, document.body)}
          </div>
        ))}
        {menus.length > 0 && <button type="button" className="rounded border border-line px-3 py-1.5 text-xs text-content sm:hidden" onClick={() => { setOpen(null); setSheet(true); }}>Actions ▾</button>}
        <Modal open={sheet} onClose={() => setSheet(false)} title="Record actions" size="sm">
          {sheet && menus.map((group) => <section key={group.id} className="mb-4"><h3 className="px-2 text-sm font-medium text-content">{group.label}{group.items.some((a) => a.badge) && <span className="text-muted"> · {group.items.map((a) => a.badge).filter(Boolean).join(" · ")}</span>}</h3>{group.items.map((item) => entry(item))}</section>)}
        </Modal>
      </div>
    </RecordActionProvider>
  );
}

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
      <RecordActionItem id={action.id} group={action.group ?? "more"} primary={action.primary} label={action.label} description={action.description ?? ""}><ActionDescription description={action.description || action.label}><button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          go();
        }}
        disabled={pending}
        title={action.description ?? action.label}
        className={
          "rounded-md border text-xs px-2 py-1.5 transition flex items-center gap-1 " +
          (flash === "ok"
            ? "border-moss-200 bg-moss-50 text-moss-600"
            : flash === "err"
            ? "border-ember-200 bg-ember-50 text-ember-600 dark:text-ember-400"
            : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800/70 hover:text-accent dark:hover:text-cobble-300")
        }
      >
        {flash === "ok" ? "done" : flash === "err" ? "err" : pending ? "…" : action.label}
      </button></ActionDescription></RecordActionItem>
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
      <RecordActionItem id={binding.action_id} group={binding.group ?? "more"} primary={binding.primary} label={binding.label} description={binding.description ?? ""}><ActionDescription description={binding.description || binding.label}><button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          go();
        }}
        disabled={pending}
        title={binding.label}
        className={
          "rounded-md border text-xs px-2 py-1.5 transition flex items-center gap-1 " +
          (flash === "ok"
            ? "border-moss-200 bg-moss-50 text-moss-600"
            : flash === "err"
            ? "border-ember-200 bg-ember-50 text-ember-600 dark:text-ember-400"
            : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800/70 hover:text-accent dark:hover:text-cobble-300")
        }
      >
        {flash === "ok" ? "done" : flash === "err" ? "err" : pending ? "…" : binding.label}
      </button></ActionDescription></RecordActionItem>
      <ActionOutcome note={note} failure={failure} onDismiss={dismissFailure} asking={asking} />
    </>
  );
}
