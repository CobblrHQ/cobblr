// Action labels (#3897): make one, and look after the ones on your walls.
//
// A record's "Action label" chip opens this page with the record in the
// query (`?kind=&id=&title=`). It offers that record's own buttons, the
// actions a person can press on it, and asks for anything the action needs
// that a scan cannot ask ("What was done" for Log service), so the printed
// label can never meet a refusal. The new button goes on a new label, or on
// one you already have ("Bathroom": toilet paper and hand soap), which is how
// one label comes to hold several buttons.
//
// Below it, every label: its buttons, its link, Print again, Rename, and Turn
// off (a turned-off label says so when scanned, and does nothing). Turned-off
// labels stay, under Off, with Turn back on and Turn on and reprint: the
// scanned page sends a person here, so here has to have the way back (#3992).

import { useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Printer, QrCode, Plus, Power, Pencil, RotateCcw } from "lucide-react";
import { SEGMENTED_MAX, SegmentedChoice, StatusRow, usePlatformWeb, useToast, usePageTitle } from "@cobblr/platform-web";
import { askBeforePress, pressAnswersToArgs, pressStillNeeds } from "@cobblr/platform-contract/action-args";
import { useLabels } from "./context";
import type { ActionLabel, ActionLabelButton } from "./api";

import { countOf } from "@cobblr/platform-contract/plural";
const input =
  "w-full rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-2 text-base text-content dark:text-slate-100";

export function ActionLabelsPage() {
  usePageTitle("Action labels");
  const [params] = useSearchParams();
  const kind = params.get("kind");
  const id = params.get("id");
  const recordTitle = params.get("title") ?? "";
  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100">Action labels</h1>
        <p className="text-sm text-muted dark:text-slate-400">
          A printed code that does one thing when scanned with any phone camera: it shows what will happen and waits for Confirm.
        </p>
      </header>
      {kind && id ? (
        <Composer kind={kind} id={id} recordTitle={recordTitle} />
      ) : (
        <p className="text-sm text-muted dark:text-slate-400">
          To make one, open the thing it is for (a pack of toilet paper, a printer) and press <strong>Action label</strong> beside Print label.
        </p>
      )}
      <LabelList />
    </div>
  );
}

function Composer({ kind, id, recordTitle }: { kind: string; id: string; recordTitle: string }) {
  const { api: platformApi, orgSlug } = usePlatformWeb();
  const { api } = useLabels();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const actions = useQuery({ queryKey: ["platform-actions", orgSlug, kind], queryFn: () => platformApi.listActions(orgSlug, kind) });
  const labels = useQuery({ queryKey: ["action-labels", orgSlug], queryFn: () => api.listActionLabels() });

  // The record's own buttons: actions a person presses, and the collection's
  // own shortcuts (bindings) with their fixed arguments.
  const choices = useMemo(() => {
    const out: Array<{ key: string; label: string; action_id: string; binding_id: string | null; schema: unknown; fixed: unknown }> = [];
    // Only what a scan's Undo can take back, and never the label's own Print.
    for (const b of actions.data?.bindings ?? []) {
      if (b.undoable !== true || b.action_id === "labels:print") continue;
      out.push({ key: `b:${b.binding_id}`, label: b.label, action_id: b.action_id, binding_id: b.binding_id, schema: b.args_schema ?? null, fixed: b.args ?? null });
    }
    for (const a of actions.data?.items ?? []) {
      if (a.user_invokable === false || a.undoable !== true || a.id === "labels:print") continue;
      out.push({ key: `a:${a.id}`, label: a.label, action_id: a.id, binding_id: null, schema: a.args_schema ?? null, fixed: null });
    }
    return out;
  }, [actions.data]);

  const [pick, setPick] = useState<string>("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<string>("new");
  const [title, setTitle] = useState(recordTitle);
  const [hint, setHint] = useState("");

  const chosen = choices.find((c) => c.key === pick) ?? null;
  // Only what the action REQUIRES is asked here: a scan cannot ask, so it is
  // fixed on the label now. Optional arguments are left to the action.
  const ask = chosen ? askBeforePress(chosen.schema as never, chosen.fixed, []).filter((q) => q.required || q.oneOf) : [];
  const needs = pressStillNeeds(ask, answers);

  const save = useMutation({
    mutationFn: async () => {
      if (!chosen) throw new Error("Pick what the label does.");
      const button: ActionLabelButton = {
        entity_kind: kind,
        entity_id: id,
        action_id: chosen.action_id,
        ...(chosen.binding_id ? { binding_id: chosen.binding_id } : {}),
        ...(ask.length ? { args: pressAnswersToArgs(ask, answers) } : {}),
        label: chosen.label,
      };
      if (target === "new") return api.createActionLabel({ title: title.trim() || recordTitle, hint: hint.trim() || null, buttons: [button] });
      const existing = labels.data?.items.find((l) => l.id === target);
      if (!existing) throw new Error("That label is gone.");
      return api.updateActionLabel(existing.id, { buttons: [...existing.buttons, button] });
    },
    onSuccess: async (label) => {
      await api.printActionLabel(label.id).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ["action-labels", orgSlug] });
      void qc.invalidateQueries({ queryKey: ["labels-queue"] });
      toast.success(`“${label.title}” is in the print queue.`);
      navigate("/labels/action", { replace: true });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't make the label."),
  });

  const live = (labels.data?.items ?? []).filter((l) => !l.revoked_at);

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-4" data-testid="action-label-composer">
      <div className="text-[10px] uppercase tracking-widest text-accent">new button for {recordTitle || "this record"}</div>
      {labels.data?.complete === false && <p className="text-sm text-muted">Showing {labels.data.items.length} of {countOf(labels.data.total ?? 0, "label")}.</p>}
      {actions.isLoading ? (
        <Loader2 size={16} className="animate-spin text-faint" />
      ) : choices.length === 0 ? (
        <p className="text-sm text-muted dark:text-slate-400">This record has nothing a label could press.</p>
      ) : (
        <div className="space-y-2">
          <span className="block text-sm text-muted dark:text-slate-400 mb-1">When scanned, it should</span>
          {choices.length > SEGMENTED_MAX ? (
            // More than a handful is a list to choose from, not a row of buttons.
            <select
              aria-label="When scanned, it should"
              className={input}
              value={pick ?? ""}
              onChange={(e) => {
                setPick(e.target.value);
                setAnswers({});
              }}
            >
              <option value="">Choose</option>
              {choices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <SegmentedChoice
              stack
              label="When scanned, it should"
              value={pick}
              onChange={(k) => {
                setPick(k);
                setAnswers({});
              }}
              options={choices.map((c) => ({ value: c.key, label: c.label }))}
            />
          )}
        </div>
      )}
      {ask.map((q) => (
        <label key={q.arg} className="block space-y-1">
          <span className="text-sm text-muted dark:text-slate-400">{q.label} (on every scan)</span>
          {q.kind === "choice" ? (
            <select className={input} value={answers[q.arg] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.arg]: e.target.value }))}>
              <option value="">Choose</option>
              {(q.choices ?? []).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={input}
              inputMode={q.kind === "number" ? "decimal" : undefined}
              value={answers[q.arg] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.arg]: e.target.value }))}
            />
          )}
        </label>
      ))}
      <label className="block space-y-1">
        <span className="text-sm text-muted dark:text-slate-400">Put it on</span>
        <select className={input} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="new">A new label</option>
          {live.map((l) => (
            <option key={l.id} value={l.id}>
              “{l.title}” ({l.buttons.length} button{l.buttons.length === 1 ? "" : "s"})
            </option>
          ))}
        </select>
      </label>
      {target === "new" && (
        <>
          <label className="block space-y-1">
            <span className="text-sm text-muted dark:text-slate-400">What it's called</span>
            <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Bathroom" maxLength={60} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-muted dark:text-slate-400">Printed beside the code</span>
            <input className={input} value={hint} onChange={(e) => setHint(e.target.value)} placeholder="e.g. Took a pack? Scan me" maxLength={120} />
          </label>
        </>
      )}
      <button
        type="button"
        disabled={!chosen || needs.length > 0 || save.isPending}
        onClick={() => save.mutate()}
        title={needs.length ? `Needs ${needs.join(", ")}` : undefined}
        className="w-full min-h-[48px] rounded-lg bg-accent text-white font-medium disabled:opacity-50 inline-flex items-center justify-center gap-2"
      >
        <Plus size={16} /> {target === "new" ? "Make the label and print it" : "Add it and print again"}
      </button>
    </section>
  );
}

function LabelList() {
  const { api, orgSlug } = useLabels();
  const qc = useQueryClient();
  const toast = useToast();
  const labels = useQuery({ queryKey: ["action-labels", orgSlug], queryFn: () => api.listActionLabels() });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["action-labels", orgSlug] });

  const [show, setShow] = useState<"on" | "off">("on");
  if (labels.isLoading) return <Loader2 size={16} className="animate-spin text-faint" />;
  const items = labels.data?.items ?? [];
  if (items.length === 0) return null;
  const on = items.filter((l) => !l.revoked_at);
  const off = items.filter((l) => !!l.revoked_at);
  // With nothing off there is no Off tab, so there is nothing to be on but On:
  // turning back the last one must not leave the page showing an empty Off.
  const view = off.length === 0 ? "on" : show;
  const shown = view === "on" ? on : off;
  const tab = (key: "on" | "off", label: string, n: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === key}
      onClick={() => setShow(key)}
      className={`rounded-full px-3 py-1.5 text-sm ${view === key ? "bg-accent text-white" : "border border-line dark:border-slate-600 text-muted dark:text-slate-300"}`}
    >
      {label} ({n})
    </button>
  );
  return (
    <section className="space-y-2" data-testid="action-label-list">
      {labels.data?.complete === false && <p className="text-sm text-muted">Showing {items.length} of {countOf(labels.data.total ?? 0, "label")}.</p>}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-content dark:text-mortar-100">Your action labels</h2>
        {off.length > 0 && (
          <div role="tablist" aria-label="Which labels" className="flex gap-1.5">
            {tab("on", "On", on.length)}
            {tab("off", "Off", off.length)}
          </div>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted dark:text-slate-400">{view === "on" ? "Every label is turned off. They are under Off." : "No label is turned off."}</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((l) => (
            <LabelRow key={l.id} label={l} onChanged={refresh} onError={(m) => toast.error(m)} onDone={(m) => toast.success(m)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LabelRow({ label, onChanged, onError, onDone }: { label: ActionLabel; onChanged: () => void; onError: (m: string) => void; onDone: (m: string) => void }) {
  const { api } = useLabels();
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(label.title);
  const [confirmOff, setConfirmOff] = useState(false);
  const off = !!label.revoked_at;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      onDone(done);
      onChanged();
      void qc.invalidateQueries({ queryKey: ["labels-queue"] });
    } catch (e) {
      onError(e instanceof Error ? e.message : "That didn't work.");
    }
  };
  return (
    <li className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <QrCode size={18} className={off ? "text-faint mt-0.5" : "text-accent mt-0.5"} />
        <div className="flex-1 min-w-0">
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setRenaming(false);
                if (name.trim() && name.trim() !== label.title) void run(() => api.updateActionLabel(label.id, { title: name.trim() }), "Renamed.");
              }}
            >
              <input aria-label="Name" className={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
            </form>
          ) : (
            <div className="text-base font-medium text-content dark:text-slate-100 truncate">
              {label.title} {off && <span className="text-xs font-normal text-faint">(turned off)</span>}
            </div>
          )}
          <div className="text-xs text-muted dark:text-slate-400">
            {label.buttons.length} button{label.buttons.length === 1 ? "" : "s"} · <span className="break-all">{label.url}</span>
          </div>
        </div>
      </div>
      <StatusRow
        state={off ? "off" : "on"}
        className="flex flex-wrap gap-2"
        testId="action-label-actions"
        states={{
          off: (
            <>
              <button
                type="button"
                onClick={() => void run(() => api.restoreActionLabel(label.id), "Back on. The printed code works again.")}
                className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm"
              >
                <RotateCcw size={14} /> Turn back on
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    await api.restoreActionLabel(label.id);
                    await api.printActionLabel(label.id);
                  }, "Back on, and a fresh copy is in the print queue.")
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm"
              >
                <Printer size={14} /> Turn on and reprint
              </button>
            </>
          ),
          on: (
            <>
              <button type="button" onClick={() => void run(() => api.printActionLabel(label.id), "In the print queue.")} className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm">
                <Printer size={14} /> Print again
              </button>
              <button
                type="button"
                onClick={() => (confirmOff ? void run(() => api.revokeActionLabel(label.id), "Turned off. Scanning it now does nothing.") : setConfirmOff(true))}
                className="inline-flex items-center gap-1.5 rounded-md border border-ember-300 dark:border-ember-700 px-3 py-2 text-sm text-ember-700 dark:text-ember-300"
              >
                <Power size={14} /> {confirmOff ? "Sure? Turn it off" : "Turn off"}
              </button>
            </>
          ),
        }}
        // A label turned off keeps its name, and the name can still change
        // before it is turned back on (#5774).
        always={
          <button type="button" onClick={() => setRenaming(true)} className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm">
            <Pencil size={14} /> Rename
          </button>
        }
      />
    </li>
  );
}
