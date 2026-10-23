// The buttons a notification says it has.
//
// One component, because there are two inboxes — the bell and the full
// notifications page — and they had already drifted once over the card body.
// What a button DOES is never decided here: the notification declares its
// actions at dispatch and each press runs a platform action, so a module makes
// its notification answerable without touching any UI.
//
// This is the app's half of a seam Discord has had for a long time. Dispatch
// wrote `actions`, the Discord card rendered them, and Cobblr's own inbox
// showed a sentence — so the one place a notification could not be acted on
// was the app it came from (audit, 2026-09-06).
//
// A card with ROWS puts each line's buttons beside that line, and a press
// settles only its row: the digest of fifteen groceries used to be a list
// and then a block of fifteen buttons, and one press took every other button
// with it (#3282). A card without rows keeps the flat strip.
//
// What was pressed HERE is only a courtesy until the list refetches. Whether
// a question is still open is the server's to say (`settled`, read from the
// subject's own record): component state alone forgot a Deny the moment the
// popover closed (#3594).

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { relativeTime, undoStepsOf, useRunAction } from "@cobblr/platform-web";
import { api, ApiError, type CrossOrgNotificationEntry } from "../lib/api";
import { notificationKeys } from "../lib/notification-keys";
import { repeatsMessage } from "../lib/notification-lines";

const STYLES = {
  primary:
    "rounded border border-cobble-500 bg-cobble-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-cobble-700 disabled:opacity-50",
  danger:
    "rounded border border-ember-500 px-2.5 py-1 text-[11px] font-medium text-ember-500 hover:bg-ember-500/10 disabled:opacity-50",
  secondary:
    "rounded border border-line dark:border-slate-600 px-2.5 py-1 text-[11px] font-medium text-muted hover:text-content disabled:opacity-50",
} as const;

type Action = NonNullable<CrossOrgNotificationEntry["actions"]>[number];

/** The way back from a press that went wrong: the action's own inverse, run
 *  through the door as the person who pressed (#7934). Only drawn when the
 *  press handed one back, so a notification whose action has none shows none. */
function UndoPress({ undo, onUndone }: { undo: unknown; onUndone: () => void }) {
  // PRESS-ARGS: it runs the step the press handed back, which carries every argument it needs.
  const run = useRunAction();
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  return (
    <button
      type="button"
      disabled={state === "busy"}
      onClick={async (e) => {
        e.stopPropagation();
        setState("busy");
        try {
          for (const step of undoStepsOf(undo)) {
            await run({ actionId: step.action_id, ...(step.entity_kind !== undefined ? { entityKind: step.entity_kind } : {}), ...(step.entity_id !== undefined ? { entityId: step.entity_id } : {}), args: step.args ?? {} }, { undo: "is-undo" });
          }
          onUndone();
        } catch {
          setState("failed");
        }
      }}
      className="ml-1.5 text-[11px] text-accent hover:underline disabled:opacity-50"
    >
      {state === "failed" ? "Couldn't undo" : "Undo"}
    </button>
  );
}

/** A row's text carries light markdown (**bold**); render that and nothing else. */
function RowText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <span className="min-w-0 max-w-full text-xs text-content dark:text-mortar-100 [overflow-wrap:anywhere]">
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>,
      )}
    </span>
  );
}

export function NotificationActionButtons({ n }: { n: CrossOrgNotificationEntry }) {
  const qc = useQueryClient();
  /** What it did, in the words the notification chose, keyed by the row it
   *  was pressed on ("" for the flat strip). Replacing the buttons is the
   *  point: a question that has been answered stops asking. */
  const [done, setDone] = useState<Record<string, string>>({});
  /** The way back for what was pressed here, by the same key. */
  const [undos, setUndos] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const press = useMutation({
    mutationFn: ({ actionId }: { actionId: string; rowKey: string }) => api.pressNotificationAction(n.id, actionId),
    onSuccess: (r, vars) => {
      setError(null);
      setDone((d) => ({ ...d, [vars.rowKey]: r.label }));
      setUndos((u) => (r.undo?.length ? { ...u, [vars.rowKey]: r.undo } : u));
      void qc.invalidateQueries({ queryKey: notificationKeys.all() });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  /** An Undo that went through: the question is open again, here and for the next read. */
  const takeBack = (rowKey: string) => {
    setDone((d) => { const { [rowKey]: _gone, ...rest } = d; return rest; });
    setUndos((u) => { const { [rowKey]: _gone, ...rest } = u; return rest; });
    void qc.invalidateQueries({ queryKey: notificationKeys.all() });
  };

  // Decided, by whoever and wherever: the server read it off the request's own
  // record, so a reopened popover and a reload say the same thing (#3594).
  if (n.settled) {
    return (
      <div className="mt-2 text-[11px] text-muted dark:text-slate-400" data-testid="notification-settled">
        {n.settled.label}
        {n.settled.at ? ` · ${relativeTime(n.settled.at)}` : ""}
      </div>
    );
  }
  // Every button answered: the rows still say how, so the card is not silent.
  if ((!n.actions || n.actions.length === 0) && !n.card?.rows?.some((r) => r.settled)) return null;
  const byId = new Map((n.actions ?? []).map((a) => [a.id, a]));

  const buttonFor = (a: Action, rowKey: string, label: string) => (
    <button
      key={a.id}
      type="button"
      disabled={press.isPending}
      onClick={(e) => {
        // Both inboxes navigate on a row click; a button is a different
        // instruction and must not also move you.
        e.stopPropagation();
        press.mutate({ actionId: a.id, rowKey });
      }}
      className={"max-w-full [overflow-wrap:anywhere] " + STYLES[a.style ?? "secondary"]}
    >
      {label}
    </button>
  );

  const rows = n.card?.rows;
  if (rows && rows.length > 0) {
    return (
      <div className="mt-2 space-y-1.5">
        {rows.map((row, i) => {
          const key = String(i);
          const acts = (row.actions ?? []).map((id) => byId.get(id)).filter((a): a is Action => !!a);
          return (
            <div key={key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1" data-testid="notification-row">
              {/* A row that only repeats the title keeps its buttons, not its words. */}
              {!repeatsMessage(row.text, n.message) && <RowText text={row.text} />}
              {row.settled ? (
                // Answered, here or elsewhere: the server read it off the record, so a reload says the same.
                <span className="text-[11px] text-muted dark:text-slate-400" data-testid="notification-row-settled">
                  {row.settled.label}
                  {row.settled.at ? ` · ${relativeTime(row.settled.at)}` : ""}
                </span>
              ) : done[key] ? (
                <span className="text-[11px] text-muted dark:text-slate-400">
                  {done[key]}
                  {undos[key] ? <UndoPress undo={undos[key]} onUndone={() => takeBack(key)} /> : null}
                </span>
              ) : (
                <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">{acts.map((a) => buttonFor(a, key, a.short ?? a.label))}</span>
              )}
            </div>
          );
        })}
        {error && <span className="text-[11px] text-ember-500">{error}</span>}
      </div>
    );
  }

  if (done[""]) return (
    <div className="mt-2 text-[11px] text-muted dark:text-slate-400">
      {done[""]}
      {undos[""] ? <UndoPress undo={undos[""]} onUndone={() => takeBack("")} /> : null}
    </div>
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {(n.actions ?? []).map((a) => buttonFor(a, "", a.label))}
      {error && <span className="text-[11px] text-ember-500">{error}</span>}
    </div>
  );
}
