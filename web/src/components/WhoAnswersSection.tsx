// "Who does what, in order" on the workspace AI page (#3842, #5622).
//
// One row per kind of work, read as a chain ("My Claude · Haiku ·
// latest (5.5) → Google Gemini · Flash Lite"). An owner or admin taps a job
// to change the workspace's order for everyone here: each step's connection
// and model (the same picker as a person's own defaults on Your account),
// its place in the order, and which connections it asks at all. Everyone
// else reads it. With nothing chosen here a row shows who answers now, and
// the first change saves that as the workspace's order.
import { useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, ApiError, type WorkspaceAiOrder } from "../lib/api";
import { aiAvailabilityKeys } from "../lib/ai-availability-keys";
import { AI_JOB_GROUPS, WHO_ANSWERS_ANCHOR, chainSummary, chainWarnings, sectionWarnings, type AiChainAnswer, type AiJobGroup } from "../lib/ai-chain";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast } from "@cobblr/platform-web";
import { ServicesInOrder } from "./ServicesInOrder";
import { JobRow } from "./YourAiDefaults";
import { PersonalDocumentsReader, usePersonalDocumentsReader } from "./PersonalDocumentsReader";

export { WHO_ANSWERS_ANCHOR } from "../lib/ai-chain";

export function WhoAnswersSection() {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const chains = useQueries({
    queries: AI_JOB_GROUPS.map((g) => ({
      queryKey: aiAvailabilityKeys.chain(activeSlug, g.shows),
      queryFn: () => api.getAiChain(activeSlug, g.shows),
      enabled: !!activeSlug,
    })),
  });
  const order = useQuery({
    queryKey: aiAvailabilityKeys.workspaceOrder(activeSlug),
    queryFn: () => api.getWorkspaceAiOrder(activeSlug),
    enabled: !!activeSlug,
  });
  const settle = (next?: WorkspaceAiOrder) => {
    if (next) qc.setQueryData(aiAvailabilityKeys.workspaceOrder(activeSlug), next);
    void qc.invalidateQueries({ queryKey: aiAvailabilityKeys.all() });
  };
  const save = useMutation({
    mutationFn: ({ job, steps }: { job: string; steps: Array<{ credential_id: string; model: string }> }) =>
      steps.length
        ? api.setWorkspaceAiOrder(activeSlug, job, steps.map((s) => ({ connection: s.credential_id, model: s.model })))
        : api.clearWorkspaceAiOrder(activeSlug, job),
    onSuccess: settle,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const relist = useMutation({
    mutationFn: () => api.getWorkspaceAiOrder(activeSlug, true),
    onSuccess: (next) => qc.setQueryData(aiAvailabilityKeys.workspaceOrder(activeSlug), next),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const reader = usePersonalDocumentsReader();
  // The rows wait for who reads personal documents: its row is drawn in the
  // middle of them once known, and pushes the buttons of the rows below it.
  const readerAnswered = !reader.isPending || reader.failureCount > 0;
  const view = order.data;
  const all = chains.map((c) => c.data).filter((d): d is AiChainAnswer => !!d);
  const warnings = all.length === AI_JOB_GROUPS.length ? sectionWarnings(all) : [];
  const lists = !!view?.connections.some((c) => Object.values(c.jobs).some((j) => j?.choices));
  const marked = highlight ? view?.connections.find((c) => c.id === highlight) : undefined;

  return (
    <section id={WHO_ANSWERS_ANCHOR} className="scroll-mt-20 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <div className="flex items-start gap-3">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Who does what, in order</h2>
        {view?.can_edit && lists && (
          <button type="button" onClick={() => relist.mutate()} disabled={relist.isPending} className="ml-auto shrink-0 text-xs text-muted underline hover:text-content disabled:opacity-50" data-refresh-models>
            {relist.isPending ? "Refreshing…" : "Refresh models"}
          </button>
        )}
      </div>
      <p className="text-xs text-faint mt-0.5 mb-3">
        When the first is busy or failing, a call asks the next, up to three.{" "}
        {view?.can_edit
          ? "Tap a job to change this workspace's order for everyone here: each step's model, its place, and which connections it asks."
          : "Only an owner or admin changes this workspace's order."}
      </p>
      {view?.connections
        .filter((c) => c.fallback)
        .map((c) => (
          <p key={c.id} className="mb-1 text-xs text-muted" title={c.fallback} data-models-fallback>
            Couldn't ask {c.label} for its current list, so its usual models are shown.
          </p>
        ))}
      {marked && (
        <p className="mb-1 text-xs text-muted" data-where-used>
          Marked: where {marked.label} answers ·{" "}
          <button type="button" onClick={() => setHighlight(null)} className="underline hover:text-content">
            Show all
          </button>
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="mb-3 space-y-0.5">
          {warnings.map((x) => (
            <li key={x} className="text-xs text-amber-700 dark:text-amber-300">
              {x}
            </li>
          ))}
        </ul>
      )}
      {!view || !readerAnswered ? (
        <p className="text-xs text-faint">Checking…</p>
      ) : (
        <div className="divide-y divide-line dark:divide-slate-700">
          {AI_JOB_GROUPS.map((g, i) => {
            // Who reads personal documents is the workspace's own setting,
            // not an order of steps (#5621).
            if (g.id === "personal") return <PersonalDocumentsReader key={g.id} />;
            const job = view.jobs.find((j) => j.id === g.id);
            if (!job) return null;
            return (
              <JobRow
                key={g.id}
                group={g}
                job={job}
                data={view}
                verification={() => undefined}
                pending={save.isPending}
                open={open === g.id}
                onToggle={() => view.can_edit && setOpen((o) => (o === g.id ? null : g.id))}
                highlight={highlight}
                onHighlight={(id) => setHighlight((h) => (h === id ? null : id))}
                onSave={(steps) => save.mutate({ job: g.id, steps })}
                onUseMineThere={() => {}}
                readOnly={!view.can_edit}
                emptyText={emptyFor(chains[i]?.data ?? null)}
                firstText="Choose this workspace's order"
                footer={
                  <JobFooter
                    group={g}
                    chosen={job.chosen}
                    canEdit={view.can_edit}
                    pending={save.isPending}
                    answer={chains[i]?.data ?? null}
                    onAutomatic={() => save.mutate({ job: g.id, steps: [] })}
                  />
                }
              />
            );
          })}
        </div>
      )}
      {/* After the rows: it is a line high before they are drawn, and moves with them. */}
      {view && readerAnswered && <ServicesInOrder />}
    </section>
  );
}

/** A row with nothing to edit says who answers anyway: a person's own
 *  defaults, or the plan's AI. */
function emptyFor(answer: AiChainAnswer | null): string {
  const summary = answer ? chainSummary(answer.you) : null;
  return summary ? `Answered now by ${summary}.` : "Nothing here can do this yet.";
}

function JobFooter({
  group,
  chosen,
  canEdit,
  pending,
  answer,
  onAutomatic,
}: {
  group: AiJobGroup;
  chosen: boolean;
  canEdit: boolean;
  pending: boolean;
  answer: AiChainAnswer | null;
  onAutomatic: () => void;
}) {
  const steps = answer?.you.steps ?? [];
  const warnings = answer ? chainWarnings(group, answer) : [];
  const automations = answer?.automations.steps.filter((s) => s.asked) ?? [];
  return (
    <div className="mt-1 space-y-0.5 text-[11px]">
      <p className="text-muted" data-order-owner>
        {chosen ? "This workspace's order, for everyone here." : "Automatic: nothing chosen here."}
        {chosen && canEdit && (
          <>
            {" "}
            <button type="button" disabled={pending} onClick={onAutomatic} className="text-accent hover:underline disabled:opacity-50">
              Back to automatic
            </button>
          </>
        )}
      </p>
      {!chosen && steps.some((s) => s.your_default) && (
        <p className="text-muted">
          Your own order for {group.phrase}, in every workspace you use.{" "}
          <Link to="/me/connections" className="text-accent hover:underline">
            Change it on Your account, Connections
          </Link>
        </p>
      )}
      {answer && (
        <p className="text-faint">
          With nobody at the keyboard (automations, background work):{" "}
          {automations.length ? automations.map((s) => s.label).join(", then ") : "nothing answers"}.
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="space-y-0.5">
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
