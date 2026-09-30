// "Who answers, in order" on the workspace AI page (#3842).
//
// The only ordering control used to be a pairwise "use this one first"
// inside one connection's edit panel, per workspace: no view of the whole
// chain, no third position, nothing per job. This shows the chain the router
// actually walks (GET /ai-chain, built from the router's own decision), one
// list per kind of work, with what would go wrong in words beside it.
import { useMutation, useQueries } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { aiAvailabilityKeys } from "../lib/ai-availability-keys";
import { AI_JOB_GROUPS, chainWarnings, reorderedOwn, sectionWarnings, sourceWords, type AiChainAnswer, type AiJobGroup } from "../lib/ai-chain";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast } from "@cobblr/platform-web";
import { ServicesInOrder } from "./ServicesInOrder";

export const WHO_ANSWERS_ANCHOR = "who-answers";

export function WhoAnswersSection() {
  const { activeSlug, activeOrg } = useActiveOrg();
  const chains = useQueries({
    queries: AI_JOB_GROUPS.map((g) => ({
      queryKey: aiAvailabilityKeys.chain(activeSlug, g.shows),
      queryFn: () => api.getAiChain(activeSlug, g.shows),
      enabled: !!activeSlug,
    })),
  });

  return (
    <section id={WHO_ANSWERS_ANCHOR} className="scroll-mt-20 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Who does what, in order</h2>
      <p className="text-xs text-faint mt-0.5 mb-3">
        When the first is busy or failing, a call asks the next, up to three. Move your own connections up or down to change the order.
      </p>
      {(() => {
        const all = chains.map((c) => c.data).filter((d): d is AiChainAnswer => !!d);
        const w = all.length === AI_JOB_GROUPS.length ? sectionWarnings(all) : [];
        return w.length ? (
          <ul className="mb-3 space-y-0.5">
            {w.map((x) => (
              <li key={x} className="text-xs text-amber-700 dark:text-amber-300">
                {x}
              </li>
            ))}
          </ul>
        ) : null;
      })()}
      <div className="space-y-4">
        {AI_JOB_GROUPS.map((g, i) => (
          <JobChain key={g.id} group={g} answer={chains[i]?.data ?? null} loading={!!chains[i]?.isLoading} orgId={activeOrg?.id ?? null} />
        ))}
      </div>
      <ServicesInOrder />
    </section>
  );
}

function JobChain({ group, answer, loading, orgId }: { group: AiJobGroup; answer: AiChainAnswer | null; loading: boolean; orgId: string | null }) {
  const toast = useToast();
  const move = useMutation({
    mutationFn: async (next: string[]) => {
      if (!orgId) return;
      // One order for the whole group: the jobs in it are one kind of work to
      // the person arranging them.
      for (const capability of group.capabilities) {
        await api.setConnectionOrder({ org_id: orgId, credential_ids: next, capability });
      }
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const steps = answer?.you.steps ?? [];
  const warnings = answer ? chainWarnings(group, answer) : [];
  const automations = answer?.automations.steps.filter((s) => s.asked) ?? [];

  return (
    <div>
      <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent">{group.title}</h3>
      {loading ? (
        <p className="text-xs text-faint mt-1">Checking…</p>
      ) : steps.length === 0 ? (
        <p className="text-sm text-muted mt-1">Nothing here can do this yet.</p>
      ) : (
        <ol className="mt-1 divide-y divide-line dark:divide-slate-700 rounded-lg border border-line dark:border-slate-700">
          {steps.map((s) => {
            const up = s.credential_id ? reorderedOwn(steps, s.credential_id, -1) : null;
            const down = s.credential_id ? reorderedOwn(steps, s.credential_id, 1) : null;
            return (
              <li key={`${s.position}-${s.label}`} className={"flex items-center gap-2 px-3 py-2 text-sm " + (s.asked ? "" : "opacity-60")}>
                <span className="w-5 shrink-0 text-faint tabular-nums">{s.position}.</span>
                {/* Two lines: at phone width one line cut off exactly the part
                    that answers "whose is it, and does it work". */}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-content dark:text-mortar-100">{s.label}</span>
                  <span className="block text-[11px] text-muted break-words">
                    {[s.model ? (s.floating ? `${s.model} (floating)` : s.model) : null, sourceWords(s.source), s.status]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {!s.asked && <span className="block text-[11px] text-faint">A call stops before this one.</span>}
                </span>
                {s.source === "yours" && (up || down) && (
                  <span className="flex shrink-0 gap-0.5">
                    <button
                      type="button"
                      disabled={!up || move.isPending}
                      onClick={() => up && move.mutate(up)}
                      aria-label={`Ask ${s.label} earlier for ${group.title.toLowerCase()}`}
                      className="p-1.5 rounded text-muted hover:text-content hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-30"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      disabled={!down || move.isPending}
                      onClick={() => down && move.mutate(down)}
                      aria-label={`Ask ${s.label} later for ${group.title.toLowerCase()}`}
                      className="p-1.5 rounded text-muted hover:text-content hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-30"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {answer && (
        <p className="text-[11px] text-faint mt-1">
          With nobody at the keyboard (automations, background work):{" "}
          {automations.length ? automations.map((s) => s.label).join(", then ") : "nothing answers"}.
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {warnings.map((w) => (
            <li key={w} className="text-xs text-amber-700 dark:text-amber-300">
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
