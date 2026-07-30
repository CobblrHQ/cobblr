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
import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Modal, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, type BasicRuleRow, type BasicAnswer } from "../lib/api";
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
          onClose={() => {
            setAdding(false);
            setEditing(null);
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
    <section className="border border-line dark:border-slate-700 rounded-md bg-subtle dark:bg-slate-800/40 p-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">// try it</div>
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

function RuleFormModal({ slug, rule, onClose }: { slug: string; rule: BasicRuleRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [intent, setIntent] = useState(rule?.intent ?? "");
  const [keywordsText, setKeywordsText] = useState((rule?.keywords ?? []).join(", "));
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
