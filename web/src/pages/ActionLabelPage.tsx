// /a/<code> inside a workspace: a scanned action label (#3897).
//
// The phone's own camera opened a printed QR; the resolver found the
// workspace and sent it here. The page says what each button will do, in the
// action's own planned words ("Toilet paper: 12 → 11"), and waits. Nothing
// changes until Confirm, which is a press through the one action door with
// the label's code beside it: the door checks the label is live and in this
// workspace, runs the action as the person, and the history says "via label".
// Then a short "Done", with Undo, and at the minimum an offer to put it on the
// shopping list.
//
// Signed out, the workspace shell shows the sign-in at this same URL and comes
// back here afterwards; nothing about the label is read until then.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Check, Loader2, QrCode, RotateCcw, ShoppingCart } from "lucide-react";
import { usePageTitle, useRunAction, useToast, type ActionRun } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError, type ActionLabelPreview } from "../lib/api";

type Button = ActionLabelPreview["buttons"][number];

interface UndoStep {
  action_id: string;
  args: Record<string, unknown>;
  entity_kind?: string;
  entity_id?: string;
}

interface Pressed {
  words: string;
  undo: UndoStep[];
  low: boolean;
  recordTitle: string | null;
}

function codeFromPath(): string {
  return window.location.pathname.split("/a/")[1] ?? "";
}

export function ActionLabelPage() {
  const { activeSlug } = useActiveOrg();
  const code = codeFromPath();
  const label = useQuery({
    queryKey: ["action-label", activeSlug, code],
    queryFn: () => api.actionLabelByCode(activeSlug!, code),
    enabled: !!activeSlug && !!code,
    retry: false,
  });
  usePageTitle(label.data?.title ?? "Action label");

  const card = (body: React.ReactNode) => (
    <div className="min-h-[70vh] flex items-start justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-4">{body}</div>
    </div>
  );

  if (label.isLoading) {
    return card(<Loader2 size={24} className="mx-auto animate-spin text-faint" />);
  }
  if (label.error || !label.data) {
    const e = label.error as ApiError | null;
    const turnedOff = e?.status === 410;
    return card(
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 text-center space-y-2" data-testid="action-label-dead">
        <QrCode size={28} className="mx-auto text-faint" />
        <div className="text-base font-medium text-content dark:text-mortar-100">
          {turnedOff ? "This label has been turned off" : "This label isn't one of this workspace's"}
        </div>
        <p className="text-sm text-muted dark:text-slate-400">
          {turnedOff
            ? "Nothing was changed. If it should still work, turn it back on: Action labels, under Off. The same printed code then works again."
            : "It may belong to a workspace you're not a member of. Nothing was changed."}
        </p>
        {turnedOff && (
          <Link to="/labels/action" className="inline-block rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm text-content dark:text-slate-100" data-testid="action-label-dead-manage">
            Open Action labels
          </Link>
        )}
      </div>,
    );
  }

  return card(
    <>
      <header className="space-y-1">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">action label</div>
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100">{label.data.title}</h1>
        {label.data.hint && <p className="text-sm text-muted dark:text-slate-400">{label.data.hint}</p>}
      </header>
      <ul className="space-y-3">
        {label.data.buttons.map((b) => (
          <li key={b.index}>
            <LabelButton slug={activeSlug!} code={code} button={b} />
          </li>
        ))}
      </ul>
    </>,
  );
}

function LabelButton({ slug, code, button }: { slug: string; code: string; button: Button }) {
  const qc = useQueryClient();
  const toast = useToast();
  // PRESS-ARGS: a label's buttons carry every required argument; the label is refused at making otherwise.
  const runAction = useRunAction();
  const [busy, setBusy] = useState(false);
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const planKey = ["action-label-plan", slug, code, button.index];
  const plan = useQuery({
    queryKey: planKey,
    queryFn: () =>
      api.planAction(slug, {
        actionId: button.action_id,
        entityKind: button.entity_kind,
        entityId: button.entity_id,
        ...(button.binding_id ? { bindingId: button.binding_id } : {}),
        ...(button.args ? { args: button.args } : {}),
      }),
    enabled: button.available,
    // What will happen has to be what IS: re-read after every press.
    staleTime: 0,
  });

  const heading = plan.data?.plan?.title ?? `${button.label ?? button.action_label}${button.record_title ? ` · ${button.record_title}` : ""}`;

  const confirm = async () => {
    setBusy(true);
    try {
      const out = (await runAction({
        actionId: button.action_id,
        entityKind: button.entity_kind,
        entityId: button.entity_id,
        ...(button.binding_id ? { bindingId: button.binding_id } : {}),
        ...(button.args ? { args: button.args } : {}),
        label: code,
      })) as ActionRun & { undo?: UndoStep[] };
      const result = (out.result ?? {}) as { newQty?: number; low?: boolean; summary?: string };
      setPressed({
        words: typeof result.newQty === "number" ? `Done. ${button.record_title ?? "It"} is at ${result.newQty} now.` : result.summary ?? "Done.",
        undo: Array.isArray(out.undo) ? out.undo : [],
        low: result.low === true,
        recordTitle: button.record_title,
      });
      void qc.invalidateQueries({ queryKey: planKey });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!pressed) return;
    setBusy(true);
    try {
      for (const step of pressed.undo) {
        await runAction({
          actionId: step.action_id,
          entityKind: step.entity_kind ?? "",
          entityId: step.entity_id ?? "",
          args: step.args,
          label: code,
        });
      }
      setPressed(null);
      toast.success("Undone.");
      void qc.invalidateQueries({ queryKey: planKey });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't undo that.");
    } finally {
      setBusy(false);
    }
  };

  const addToList = async () => {
    setBusy(true);
    try {
      await runAction({
        actionId: "lists:add-item",
        entityKind: "",
        entityId: "",
        args: { title: pressed?.recordTitle ?? button.record_title ?? "", listTitle: "Shopping list" },
        label: code,
      });
      toast.success(`${pressed?.recordTitle ?? "It"} is on the shopping list.`);
      setPressed((p) => (p ? { ...p, low: false } : p));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add it to the list.");
    } finally {
      setBusy(false);
    }
  };

  if (!button.available) {
    return (
      <div className="rounded-xl border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-900 p-4 text-sm text-muted dark:text-slate-400">
        {button.label ?? button.action_label}: this button no longer works (its record or action has gone).
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3" data-testid="action-label-button">
      <div>
        <div className="text-lg font-semibold text-content dark:text-mortar-100" data-testid="action-label-plan">
          {plan.isLoading ? <Loader2 size={16} className="animate-spin text-faint" /> : heading}
        </div>
        {plan.data?.plan?.lines.map((l) => (
          <div key={l} className="text-sm text-muted dark:text-slate-400">
            {l}
          </div>
        ))}
        {plan.data?.error && <div className="text-sm text-ember-700 dark:text-ember-300">{plan.data.error}</div>}
      </div>
      {pressed ? (
        <div className="space-y-2" role="status">
          <div className="flex items-center gap-2 text-sm text-moss-700 dark:text-moss-300">
            <Check size={16} /> {pressed.words}
          </div>
          <div className="flex flex-wrap gap-2">
            {pressed.undo.length > 0 && (
              <button
                type="button"
                onClick={undo}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm text-content dark:text-slate-100"
              >
                <RotateCcw size={14} /> Undo
              </button>
            )}
            {pressed.low && (
              <button
                type="button"
                onClick={addToList}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white"
              >
                <ShoppingCart size={14} /> Running low: add to shopping list
              </button>
            )}
            <button
              type="button"
              onClick={() => setPressed(null)}
              className="rounded-md px-3 py-2 text-sm text-muted hover:text-content"
            >
              Again
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={confirm}
          disabled={busy || !!plan.data?.error}
          data-testid="action-label-confirm"
          className="w-full min-h-[56px] rounded-lg bg-accent text-white text-lg font-semibold disabled:opacity-50"
        >
          {busy ? "…" : "Confirm"}
        </button>
      )}
    </div>
  );
}
