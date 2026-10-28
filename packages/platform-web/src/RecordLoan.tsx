import { RecordActionItem } from "./RecordActionContributions";
// A thing lent out, and back, on its own page (#6335).
//
// A record that is out says so in one line above its fields: "With Sam
// Lai · repair · since Oct 13, 2026 (due Oct 27, 2026) · returns to Front
// Hallway", with It's back beside it. A record at home offers "Lend…", which
// asks who has it, why and until when. Both run the kernel's actions
// (platform:lend / platform:return), the same ones the assistant uses. The
// record's own place and state are never touched: the loan is an overlay.
//
// Placed once by the platform; a detail page only says which record it is.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { HandHelping, Undo2 } from "lucide-react";
import { dayHere } from "@cobblr/platform-contract/day";
import { OFF_WHILE_LENT, lentWhy, loanOfFields, loanOverdue, sayLoan, type RecordLoan } from "@cobblr/platform-contract/loan";
import { usePlatformWeb } from "./context";
import { Modal } from "./Modal";
import { useToast } from "./ToastContext";
import { runUndoSteps, undoStepsOf, useRunAction, type RunOptions } from "./run-action";

const REASONS = ["repair", "borrowed"] as const;
const REPAIR = /repair|fix|servic/i;

/** The record's open loan, from the one query RecordLoan and every button on
 *  the page share; null while it is home (or not yet read). */
export function useRecordLoan(kind: string, id: string): RecordLoan | null {
  const { api, orgSlug } = usePlatformWeb();
  const { data } = useQuery({ queryKey: ["record-loan", orgSlug, kind, id], queryFn: () => api.lookupEntity(orgSlug, kind, id), staleTime: 30_000 });
  return data ? loanOfFields(data.fields) : null;
}

/** Why this action is off on this record now, or null: a thing lent out
 *  cannot be moved or labelled until it is back. */
export function useOffWhileLent(kind: string, id: string, actionId: string): string | null {
  const loan = useRecordLoan(kind, id);
  return loan && OFF_WHILE_LENT.has(actionId) ? lentWhy(loan) : null;
}

export function RecordLoan({ kind, id, className }: { kind: string; id: string; className?: string }) {
  const { api, orgSlug } = usePlatformWeb();
  // PRESS-ARGS: the form below asks who has it (the one required answer) before lend runs, and return needs only the record this page is.
  const runAction = useRunAction();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["record-loan", orgSlug, kind, id], queryFn: () => api.lookupEntity(orgSlug, kind, id), staleTime: 30_000 });
  const [asking, setAsking] = useState(false);
  const [returning, setReturning] = useState<RecordLoan | null>(null);
  const [busy, setBusy] = useState(false);
  // Where it goes back to: its place is kept while it is out.
  const home = useQuery({
    queryKey: ["placement-path", orgSlug, kind, id],
    queryFn: () => api.placementPath!(orgSlug, kind, id),
    enabled: !!api.placementPath,
    staleTime: 60_000,
  });
  const people = useQuery({ queryKey: ["people", orgSlug], queryFn: () => api.listPeople!(orgSlug), enabled: asking && !!api.listPeople, staleTime: 60_000 });
  if (!data) return null;
  const loan = loanOfFields(data.fields);

  const run = async (actionId: string, args: Record<string, unknown>, opts?: RunOptions) => {
    const r = await runAction({ actionId, entityKind: kind, entityId: id, args: { entity_kind: kind, ids: [id], ...args } }, opts);
    const res = r.result as { ok?: boolean; error?: string; summary?: string } | null;
    if (!res?.ok) throw new Error(res?.error ?? "That did not go through.");
    return { said: res.summary ?? "Done.", offered: !opts?.undo && undoStepsOf(r.undo).length > 0, back: undoStepsOf(r.undo) };
  };

  if (loan) {
    const late = loanOverdue(loan, dayHere(new Date()));
    return (
      <div
        data-testid="record-loan"
        className={`order-first flex w-full basis-full flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm text-content ${late ? "border-ember-200 bg-ember-50 dark:border-ember-800 dark:bg-ember-900/30" : "border-line bg-subtle dark:border-slate-600"} ${className ?? ""}`}
      >
        <HandHelping size={14} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          {sayLoan(loan)}
          {home.data?.line && <span className="text-muted"> · returns to {home.data.line}</span>}
          {late && <span className="ml-1 font-medium text-ember-700 dark:text-ember-300">· overdue</span>}
          {loan.note && <span className="block text-xs text-muted">{loan.note}</span>}
        </span>
        <RecordActionItem id="record:return" action="platform:return" group="lifecycle" label="It's back" description="The loan ends; it is at its own place again, as it was."><button
          type="button"
          disabled={busy}
          data-testid="loan-return"
          onClick={async () => {
            // Back from a repair asks whether it was, and that goes in its
            // service log; any other loan ends in one tap.
            if (REPAIR.test(loan.reason ?? "")) return setReturning(loan);
            setBusy(true);
            try {
              const { said, offered } = await run("platform:return", { expected_loans: { [id]: loan } });
              if (!offered) toast.success(said);
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600"
        >
          <Undo2 size={12} aria-hidden />
          It's back
        </button></RecordActionItem>
        <Modal open={!!returning} onClose={() => setReturning(null)} title={`${data.title} is back from ${returning?.holder ?? loan.holder}`} size="sm">
          {returning && (
            <ReturnForm
              holder={returning.holder}
              onCancel={() => setReturning(null)}
              onSave={async (args) => {
                const { said, offered } = await run("platform:return", { ...args, expected_loans: { [id]: returning } });
                setReturning(null);
                if (!offered) toast.success(said);
              }}
            />
          )}
        </Modal>
      </div>
    );
  }

  return (
    <>
      <RecordActionItem id="record:lend" action="platform:lend" group="lifecycle" label="Lend…" description="Say who has it, why and until when. Its place and state are kept."><button
        type="button"
        data-testid="lend"
        onClick={() => setAsking(true)}
        className={`order-last inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600 ${className ?? ""}`}
      >
        <HandHelping size={12} aria-hidden />
        Lend…
      </button></RecordActionItem>
      <Modal open={asking} onClose={() => setAsking(false)} title={`Who has ${data.title}?`} size="sm">
        {asking && (
          <LendForm
            people={people.data?.items ?? []}
            onCancel={() => setAsking(false)}
            onSave={async (args) => {
              const { said, back } = await run("platform:lend", args, { undo: "shown-here" });
              setAsking(false);
              // The way back the action handed over, never one written here:
              // it names this loan's holder and its undo_id, so an older tab's
              // Undo cannot end a loan made since (#7899).
              toast.success(said, back.length ? {
                actionLabel: "Undo",
                onAction: async () => {
                  try {
                    await runUndoSteps((b) => runAction(b, { undo: "is-undo" }), back);
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                },
              } : undefined);
            }}
          />
        )}
      </Modal>
    </>
  );
}

function LendForm({ people, onCancel, onSave }: { people: Array<{ id: string; name: string; left?: boolean }>; onCancel: () => void; onSave: (args: Record<string, unknown>) => Promise<void> }) {
  const [holder, setHolder] = useState("");
  const [reason, setReason] = useState<string>("");
  const [since, setSince] = useState<string>(() => dayHere(new Date()));
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-content dark:border-slate-600";
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          // Someone on the People list is linked by id, so their page lists it.
          const person = people.find((p) => p.name.trim().toLowerCase() === holder.trim().toLowerCase());
          await onSave({ holder: holder.trim(), ...(person ? { holder_id: person.id } : {}), since, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(due ? { due_back: due } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">Who has it</span>
        <input data-testid="lend-holder" required list="lend-people" className={input} value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="A name" />
        <datalist id="lend-people">
          {people.filter((p) => !p.left).map((p) => (
            <option key={p.id} value={p.name} />
          ))}
        </datalist>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">Why</span>
        <input data-testid="lend-reason" list="lend-reasons" className={input} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="repair, borrowed, or your own words" />
        <datalist id="lend-reasons">
          {REASONS.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-content">Since</span>
          <input type="date" className={input} value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-content">Due back</span>
          <input type="date" data-testid="lend-due" className={input} value={due} min={since || undefined} onChange={(e) => setDue(e.target.value)} />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">Note</span>
        <input className={input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
      </label>
      <p className="text-xs text-muted">It keeps its place, which it returns to, and its state. It's back ends the loan, and History keeps it.</p>
      {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-content">
          Cancel
        </button>
        <button type="submit" disabled={busy || !holder.trim()} data-testid="lend-save" className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? "Saving…" : "Lend"}
        </button>
      </div>
    </form>
  );
}

function ReturnForm({ holder, onCancel, onSave }: { holder: string; onCancel: () => void; onSave: (args: Record<string, unknown>) => Promise<void> }) {
  const [repaired, setRepaired] = useState<"yes" | "no" | null>(null);
  const [work, setWork] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choice = (v: "yes" | "no", label: string) => (
    <button
      type="button"
      data-testid={`return-repaired-${v}`}
      aria-pressed={repaired === v}
      onClick={() => setRepaired(repaired === v ? null : v)}
      className={`flex-1 rounded-lg border px-3 py-2 text-sm ${repaired === v ? "border-cobble-600 bg-cobble-600 text-white" : "border-line text-content dark:border-slate-600"}`}
    >
      {label}
    </button>
  );
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSave({ ...(repaired ? { repaired: repaired === "yes" } : {}), ...(repaired === "yes" && work.trim() ? { work: work.trim() } : {}) });
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm font-medium text-content">Was it repaired?</p>
      <div className="flex gap-2">
        {choice("yes", "Yes")}
        {choice("no", "No")}
      </div>
      {repaired === "yes" && (
        <label className="block space-y-1">
          <span className="text-sm font-medium text-content">What was done</span>
          <input data-testid="return-work" className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-content dark:border-slate-600" value={work} onChange={(e) => setWork(e.target.value)} placeholder="Optional" />
        </label>
      )}
      <p className="text-xs text-muted">{repaired === "yes" ? `History keeps the repair details. When available, its service log gets "Repaired by ${holder}".` : "It is home again, as it was."}</p>
      {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-content">
          Cancel
        </button>
        <button type="submit" disabled={busy} data-testid="return-save" className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? "Saving…" : "It's back"}
        </button>
      </div>
    </form>
  );
}
