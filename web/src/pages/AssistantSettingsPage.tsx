// /configuration/assistant — teach Ask Cobb's no-AI "basic mode".
//
// When a workspace has no AI provider, the chat answers from the EFFECTIVE
// ruleset: built-in rules (shipped in code) overlaid with this workspace's
// overrides + custom rules. Owners/admins edit them here; the "try it" box hits
// the same POST /basics/answer the chat uses, so what you test is what users
// get. See docs/design-decisions/no-ai-chat-training.md.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { Check, MessageCircleQuestion, Pencil, Plus, RotateCcw, Trash2, Wand2 } from "lucide-react";
import { Modal, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, type BasicRuleRow, type BasicAnswer, type BasicMissRow, type CommandCandidate } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ConfigHeaderActions } from "../components/ConfigPageHeader";

export function AssistantSettingsPage() {
  usePageTitle("Assistant");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<BasicRuleRow | null>(null);
  const [adding, setAdding] = useState(false);
  /** The unanswered question a new rule is being written for, if any. */
  const [answering, setAnswering] = useState<BasicMissRow | null>(null);

  const list = useQuery({
    queryKey: ["basics", activeSlug],
    queryFn: () => api.listBasics(activeSlug),
    enabled: !!activeSlug,
  });
  const rules = list.data?.rules ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["basics", activeSlug] });

  // Toggle enabled. A pristine built-in (id null) needs an override row created,
  // snapshotting its current fields; anything with a row just gets patched.
  const toggle = useMutation({
    mutationFn: (r: BasicRuleRow) =>
      r.id
        ? api.updateBasic(activeSlug, r.id, { enabled: !r.enabled })
        : api.createBasic(activeSlug, { builtin_key: r.key, intent: r.intent, keywords: r.keywords, reply: r.reply, enabled: !r.enabled }),
    onSuccess: () => void invalidate(),
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // DELETE resets a built-in to its shipped default, or removes a custom rule.
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteBasic(activeSlug, id),
    onSuccess: (_d, _id) => {
      toast.success("Done.");
      void invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <div className="space-y-5">
      <ConfigHeaderActions>
        <span className="text-sm text-muted dark:text-slate-400">{rules.length} answers</span>
        <button
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> New answer
        </button>
      </ConfigHeaderActions>

      <p className="text-sm text-muted dark:text-slate-400">
        These are the answers <strong>Ask Cobb</strong> gives when your workspace has <strong>no AI connected</strong>  - 
        greetings, "what can you do", how-do-I pointers. Matching is by keyword, no AI involved. Edit a built-in answer,
        turn one off, or add your own for the questions people ask you. When AI <em>is</em> connected, the full assistant
        takes over and these step aside.
      </p>

      <Tester slug={activeSlug} />

      <Commands slug={activeSlug} />

      <Unanswered
        slug={activeSlug}
        onAnswer={(m) => {
          setAnswering(m);
          setAdding(true);
        }}
      />

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}

      <ul className="space-y-2">
        {rules.map((r) => (
          <li
            key={r.key}
            className={
              "border border-line dark:border-slate-700 rounded-md bg-surface dark:bg-slate-900 p-3 " +
              (r.enabled ? "" : "opacity-60")
            }
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-content dark:text-mortar-100">{r.intent}</span>
                  <span
                    className={
                      "text-[10px] font-mono rounded px-1.5 py-0.5 " +
                      (r.builtin
                        ? "bg-mortar-100 dark:bg-slate-800 text-muted dark:text-mortar-200"
                        : "border border-cobble-200 dark:border-cobble-800 text-accent")
                    }
                  >
                    {r.builtin ? (r.id ? "built-in · edited" : "built-in") : "custom"}
                  </span>
                  {!r.enabled && <span className="text-[10px] font-mono text-ember-500">off</span>}
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {r.keywords.slice(0, 12).map((k, i) => (
                    <span key={i} className="text-[10px] font-mono bg-mortar-100 dark:bg-slate-800 text-muted dark:text-mortar-200 rounded px-1.5 py-0.5">
                      {k}
                    </span>
                  ))}
                  {r.keywords.length > 12 && <span className="text-[10px] text-faint">+{r.keywords.length - 12}</span>}
                </div>
                <div className="text-sm text-muted mt-1.5 line-clamp-2 whitespace-pre-wrap">{r.reply}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => toggle.mutate(r)}
                  title={r.enabled ? "Turn off" : "Turn on"}
                  className="text-faint hover:text-accent p-1 text-xs font-mono"
                >
                  {r.enabled ? "on" : "off"}
                </button>
                <button type="button" onClick={() => setEditing(r)} title="Edit" className="text-faint hover:text-accent p-1">
                  <Pencil size={14} />
                </button>
                {r.builtin ? (
                  r.id && (
                    <button
                      type="button"
                      onClick={() => r.id && remove.mutate(r.id)}
                      title="Reset to the shipped default"
                      className="text-faint hover:text-accent p-1"
                    >
                      <RotateCcw size={14} />
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Delete answer?",
                        message: `"${r.intent}" will be removed.`,
                        confirmLabel: "Delete",
                        destructive: true,
                      });
                      if (ok && r.id) remove.mutate(r.id);
                    }}
                    title="Delete"
                    className="text-faint hover:text-ember-500 p-1"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {(adding || editing) && (
        <RuleFormModal
          slug={activeSlug}
          rule={editing}
          seed={answering}
          onClose={() => {
            setAdding(false);
            setEditing(null);
            setAnswering(null);
          }}
        />
      )}
    </div>
  );
}

function Tester({ slug }: { slug: string }) {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<BasicAnswer | null>(null);
  const run = useMutation({
    mutationFn: () => api.answerBasic(slug, q.trim()),
    onSuccess: (r) => setResult(r),
  });
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <h2 className="text-sm font-semibold text-content dark:text-mortar-100 mb-2">Try it</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) run.mutate();
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='Ask something - "how do I add a part"'
          className="flex-1 px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
        <button
          type="submit"
          disabled={!q.trim() || run.isPending}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
        >
          Test
        </button>
      </form>
      {result && (
        <div className="mt-3 text-sm">
          <div className="prose prose-sm dark:prose-invert max-w-none text-content dark:text-mortar-100">
            <ReactMarkdown>{result.reply}</ReactMarkdown>
          </div>
          <div className="mt-2 text-xs text-muted dark:text-slate-400">
            {result.matched ? (
              <>matched <span className="font-mono text-accent">{result.intent}</span> (score {result.score})</>
            ) : (
              <>no rule matched - this is the fallback nudge</>
            )}
            {result.candidates.length > 1 && (
              <span className="ml-2">
                · also: {result.candidates.slice(1, 4).map((c) => `${c.intent} (${c.score})`).join(", ")}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Things this workspace can DO without an AI, and the ones it could learn.
 *
 *  The rest of this page is about what Cobb SAYS with no AI connected. This is
 *  what he can do: every change an AI made is recorded with the sentence that
 *  asked for it, and an example that generalises becomes a command with the
 *  numbers and names as blanks. Teaching one costs a click; running it costs
 *  nothing at all. */
function Commands({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const known = useQuery({ queryKey: ["commands", slug], queryFn: () => api.listCommands(slug), enabled: !!slug });
  const candidates = useQuery({
    queryKey: ["command-candidates", slug],
    queryFn: () => api.listCommandCandidates(slug),
    enabled: !!slug,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["commands", slug] });
    void qc.invalidateQueries({ queryKey: ["command-candidates", slug] });
  };

  const adopt = useMutation({
    mutationFn: (c: CommandCandidate) =>
      api.adoptCommand(slug, {
        template: c.template,
        pattern: c.pattern,
        slots: c.slots,
        plan: c.plan,
        ...(c.repeat_field ? { repeat_field: c.repeat_field } : {}),
        ...(c.repeat_shape ? { repeat_shape: c.repeat_shape } : {}),
      }),
    onSuccess: () => {
      toast.success("Learned. Ask for it and Cobb can do it with no AI.");
      refresh();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.setCommandEnabled(slug, v.id, v.enabled),
    onSuccess: refresh,
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const forget = useMutation({
    mutationFn: (id: string) => api.deleteCommand(slug, id),
    onSuccess: () => {
      toast.success("Forgotten.");
      refresh();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const mine = known.data?.items ?? [];
  // A candidate already adopted is not a suggestion any more.
  const taught = new Set(mine.map((c) => c.template));
  const offers = (candidates.data?.items ?? []).filter((c) => !taught.has(c.template));
  if (!mine.length && !offers.length) return null;

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <h2 className="text-sm font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
        <Wand2 size={15} className="text-muted dark:text-slate-400" />
        Things this workspace can do on its own
      </h2>
      <p className="mt-1 text-[11px] text-muted dark:text-slate-400">
        Learned from watching an AI do it once. Asking for one of these runs it with no AI involved, and every change it
        makes is undoable like any other.
      </p>

      {mine.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {mine.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2.5 py-1.5"
            >
              <code className={`flex-1 text-xs font-mono truncate ${c.enabled ? "text-content dark:text-mortar-200" : "text-faint dark:text-slate-500 line-through"}`}>
                {c.template}
              </code>
              {c.times_used > 0 && (
                <span className="text-[10px] font-mono text-faint dark:text-slate-500 shrink-0">used {c.times_used}×</span>
              )}
              <button
                type="button"
                onClick={() => toggle.mutate({ id: c.id, enabled: !c.enabled })}
                className="shrink-0 text-[11px] text-muted hover:text-content dark:hover:text-mortar-200 transition"
              >
                {c.enabled ? "Turn off" : "Turn on"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void confirm({ title: "Forget this command?", message: c.template, confirmLabel: "Forget", destructive: true }).then(
                    (ok) => ok && forget.mutate(c.id),
                  )
                }
                aria-label="Forget"
                className="shrink-0 text-faint hover:text-ember-500 transition"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {offers.length > 0 && (
        <div className="mt-3">
          <span className="text-[11px] uppercase tracking-wide text-faint dark:text-slate-500">Could learn</span>
          <ul className="mt-1 space-y-1.5">
            {offers.slice(0, 6).map((c) => (
              <li
                key={c.template}
                className="flex items-center gap-2 rounded border border-dashed border-line dark:border-slate-700 px-2.5 py-1.5"
              >
                <div className="flex-1 min-w-0">
                  <code className="block text-xs font-mono text-content dark:text-mortar-200 truncate">{c.template}</code>
                  <span className="block text-[10px] text-faint dark:text-slate-500 truncate" title={c.prompt}>
                    from “{c.prompt}” · {c.did}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => adopt.mutate(c)}
                  disabled={adopt.isPending}
                  className="shrink-0 text-[11px] rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-1 transition disabled:opacity-50"
                >
                  Teach it
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** What people asked that got the fallback answer.
 *
 *  Without this the ruleset could only grow from guesses: chat turns are swept
 *  after a day and the AI call log keeps the request envelope rather than the
 *  question, so "which phrases should we match that we don't?" had no data
 *  behind it. Every one of these is a real question in the words someone used,
 *  and one click turns it into a rule. */
function Unanswered({ slug, onAnswer }: { slug: string; onAnswer: (m: BasicMissRow) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const misses = useQuery({
    queryKey: ["basic-misses", slug],
    queryFn: () => api.listBasicMisses(slug),
    enabled: !!slug,
  });
  const items = misses.data?.items ?? [];
  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissBasicMiss(slug, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["basic-misses", slug] }),
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Nothing unanswered is the good state, and an empty box every day is noise.
  if (!items.length) return null;

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <h2 className="text-sm font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
        <MessageCircleQuestion size={15} className="text-muted dark:text-slate-400" />
        Asked, but not answered
      </h2>
      <p className="mt-1 text-[11px] text-muted dark:text-slate-400">
        Questions basic mode had no answer for, most asked first. Write one answer and it stops being a dead end for
        everyone here.
      </p>
      <ul className="mt-2 space-y-1.5">
        {items.map((m) => (
          <li
            key={m.id}
            className="flex items-center gap-2 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2.5 py-1.5"
          >
            <span className="flex-1 text-xs text-content dark:text-mortar-200 truncate" title={m.sample}>
              {m.sample}
            </span>
            {m.times > 1 && (
              <span className="text-[10px] font-mono text-faint dark:text-slate-500 shrink-0">×{m.times}</span>
            )}
            <button
              type="button"
              onClick={() => onAnswer(m)}
              className="shrink-0 text-[11px] rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-1 transition"
            >
              Answer this
            </button>
            <button
              type="button"
              onClick={() => dismiss.mutate(m.id)}
              title="Not worth an answer"
              aria-label="Dismiss"
              className="shrink-0 text-faint hover:text-content dark:hover:text-mortar-200 transition"
            >
              <Check size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RuleFormModal({
  slug,
  rule,
  seed,
  onClose,
}: {
  slug: string;
  rule: BasicRuleRow | null;
  /** An unanswered question this rule is being written FOR: its words become
   *  the starting keywords, so the common case is type-a-reply-and-save. */
  seed?: BasicMissRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [intent, setIntent] = useState(rule?.intent ?? seed?.sample.slice(0, 60) ?? "");
  const [keywordsText, setKeywordsText] = useState(
    (rule?.keywords ?? []).join(", ") || (seed ? seed.sample.trim() : ""),
  );
  const [reply, setReply] = useState(rule?.reply ?? "");

  const save = useMutation({
    mutationFn: () => {
      const keywords = keywordsText
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const body = { intent: intent.trim(), keywords, reply: reply.trim() };
      // Existing row (custom or already-overridden built-in) → PATCH.
      if (rule?.id) return api.updateBasic(slug, rule.id, body);
      // Pristine built-in → create an override snapshotting the edits.
      if (rule?.builtin) return api.createBasic(slug, { ...body, builtin_key: rule.key });
      // Brand-new custom rule.
      return api.createBasic(slug, body);
    },
    onSuccess: () => {
      toast.success(rule ? "Answer updated." : "Answer added.");
      void qc.invalidateQueries({ queryKey: ["basics", slug] });
      // Writing the answer IS dealing with the question, so it leaves the list
      // without a second click.
      if (seed) {
        void api.dismissBasicMiss(slug, seed.id).catch(() => {});
        void qc.invalidateQueries({ queryKey: ["basic-misses", slug] });
      }
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const keywordsValid = keywordsText.split(/[,\n]/).some((s) => s.trim());
  const title = rule ? (rule.builtin ? `Edit built-in "${rule.intent}"` : `Edit "${rule.intent}"`) : "New answer";

  return (
    <Modal open onClose={onClose} title={title} size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (intent.trim() && reply.trim() && keywordsValid) save.mutate();
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Label (what this answer is for)</div>
          <input
            type="text"
            required
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="e.g. return policy"
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Trigger words / phrases (comma or newline separated)</div>
          <textarea
            value={keywordsText}
            onChange={(e) => setKeywordsText(e.target.value)}
            rows={2}
            placeholder="returns, refund, send it back, how do i return"
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          <div className="text-[11px] text-faint mt-1">A longer phrase is a more specific match and beats a loose single word.</div>
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Answer (markdown OK)</div>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={5}
            placeholder="What Cobb should say…"
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">
            Cancel
          </button>
          <button
            type="submit"
            disabled={save.isPending || !intent.trim() || !reply.trim() || !keywordsValid}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {save.isPending ? "saving…" : rule ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
