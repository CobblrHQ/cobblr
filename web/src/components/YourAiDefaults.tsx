// "Who answers for you" on Your account, Connections (#5404).
//
// A person's own default AI per job, one row per job read as a chain: First,
// then each fallback ("Gemini · Flash Lite → My Claude · Haiku"). Tapping a
// row opens it to reorder the steps (drag by the grip, or the up and down
// buttons, which are also the keyboard and screen-reader way) and to pick
// each step's model. Tapping a connection's name marks every row it answers
// in. Every workspace the person uses follows these unless that workspace
// chose for the job itself, which the row says, with the way back.
//
// The rows come from per-job steps (connection, order, model), the shape a
// jobs-by-connections grid would draw too: the owner's fallback layout, on
// file on the issue, needs no other data.
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, GripVertical, Plus, X } from "lucide-react";
import { useToast, WorkspaceLink } from "@cobblr/platform-web";
import { api, ApiError, type AiModelChoiceView, type MyAiDefaults, type UserConnection } from "../lib/api";
import { aiAvailabilityKeys } from "../lib/ai-availability-keys";
import { AI_JOB_GROUPS, WHO_ANSWERS_ANCHOR, modelWords, type AiJobGroup } from "../lib/ai-chain";
import { slowForQuickLook } from "@cobblr/platform-contract/ai-models";
import { SettingsSection } from "./SettingsSection";
import { VerificationBadge } from "./ConnectionState";
import { ModelChoiceOptions } from "./ModelChoiceOptions";
import { useSortKit, type SortKit } from "./sort-kit-static";

type Step = { credential_id: string; model: string };
/** What the editor draws: a person's own defaults (#5404) or a workspace's
 *  order (#5622), one shape. */
export type JobsView = {
  jobs: Array<{
    id: string;
    title: string;
    steps: Array<{ credential_id: string; model: string; model_label?: string; label: string; provider_id: string | null; usable: boolean }>;
    own_order_in: MyAiDefaults["jobs"][number]["own_order_in"];
  }>;
  connections: Array<{ id: string; label: string; provider_id: string; jobs: Partial<Record<string, { models: string[]; default_model: string | null; choices?: AiModelChoiceView[] }>> }>;
  model_labels: Record<string, Record<string, string>>;
};
type Job = JobsView["jobs"][number];

const SELECT = "min-w-0 max-w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
const ICON_BUTTON = "p-1.5 rounded text-muted hover:text-content hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-30";

/** The steps with the one dragged (`from`) dropped where `to` was. */
export function movedStep<T>(steps: readonly T[], from: number, to: number): T[] {
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function YourAiDefaults({ connections }: { connections: UserConnection[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const mine = useQuery({ queryKey: aiAvailabilityKeys.myDefaults(), queryFn: () => api.getMyAiDefaults() });
  const [open, setOpen] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const refresh = (next?: MyAiDefaults) => {
    if (next) qc.setQueryData(aiAvailabilityKeys.myDefaults(), next);
    void qc.invalidateQueries({ queryKey: aiAvailabilityKeys.all() });
  };
  const save = useMutation({
    mutationFn: ({ job, steps }: { job: string; steps: Step[] }) => (steps.length ? api.setMyAiDefaults(job, steps) : api.clearMyAiDefaults(job)),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const useMineThere = useMutation({
    mutationFn: async ({ slug, capabilities }: { slug: string; capabilities: string[] }) => {
      for (const c of capabilities) await api.deleteAiCapabilityDefault(slug, c);
    },
    onSuccess: () => refresh(),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const relist = useMutation({
    mutationFn: () => api.getMyAiDefaults(true),
    onSuccess: (next) => qc.setQueryData(aiAvailabilityKeys.myDefaults(), next),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const data = mine.data;
  if (!data || !data.connections.length) return null;
  const verification = (id: string) => connections.find((c) => c.id === id)?.verification;
  const lists = data.connections.some((c) => Object.values(c.jobs).some((j) => j?.choices));
  const marked = highlight ? data.connections.find((c) => c.id === highlight) : undefined;

  return (
    <SettingsSection
      title="Who answers for you"
      blurb="Your own AI for each kind of work, in every workspace you use. A workspace that chose its own for a job keeps it there. Tap a job to change it; tap a connection to see where it answers."
      action={
        lists ? (
          <button type="button" onClick={() => relist.mutate()} disabled={relist.isPending} className="shrink-0 text-xs text-muted underline hover:text-content disabled:opacity-50" data-refresh-models>
            {relist.isPending ? "Refreshing…" : "Refresh models"}
          </button>
        ) : undefined
      }
    >
      {data.connections
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
      <div className="divide-y divide-line dark:divide-slate-700">
        {AI_JOB_GROUPS.map((g) => {
          const job = data.jobs.find((j) => j.id === g.id);
          if (!job) return null;
          return (
            <JobRow
              key={g.id}
              group={g}
              job={job}
              data={data}
              verification={verification}
              pending={save.isPending || useMineThere.isPending}
              open={open === g.id}
              onToggle={() => setOpen((o) => (o === g.id ? null : g.id))}
              highlight={highlight}
              onHighlight={(id) => setHighlight((h) => (h === id ? null : id))}
              onSave={(steps) => save.mutate({ job: g.id, steps })}
              onUseMineThere={(slug, capabilities) => useMineThere.mutate({ slug, capabilities })}
            />
          );
        })}
      </div>
    </SettingsSection>
  );
}

/** A step's model as the pickers name it: "Haiku · latest (5.5)" for a
 *  provider that lists its models, the provider's own name otherwise, and
 *  never a raw "-latest" id. */
function modelName(data: JobsView, s: Job["steps"][number]): string {
  if (s.model_label) return s.model_label;
  return modelWords(s.model, s.provider_id ? data.model_labels[s.provider_id]?.[s.model] : undefined);
}

/** One job: its chain, and when open, the steps to reorder and pick. */
export function JobRow({
  group,
  job,
  data,
  verification,
  pending,
  open,
  onToggle,
  highlight,
  onHighlight,
  onSave,
  onUseMineThere,
  kit,
  readOnly = false,
  emptyText,
  firstText = "Choose your own",
  footer,
}: {
  group: AiJobGroup;
  job: Job;
  data: JobsView;
  verification: (credentialId: string) => UserConnection["verification"] | undefined;
  pending: boolean;
  open: boolean;
  onToggle: () => void;
  highlight: string | null;
  onHighlight: (credentialId: string) => void;
  onSave: (steps: Step[]) => void;
  onUseMineThere: (slug: string, capabilities: string[]) => void;
  /** Drag-to-reorder; the shell's lazily loaded kit unless a test hands one in. */
  kit?: SortKit;
  /** Shown, not changed: a member reading a workspace's order. */
  readOnly?: boolean;
  /** What the row says with no steps. */
  emptyText?: string;
  /** The add button's words with no steps yet. */
  firstText?: string;
  /** Under the chain: whose order it is, and the way back. */
  footer?: ReactNode;
}) {
  const loaded = useSortKit();
  const K = kit ?? loaded;
  const able = data.connections.filter((c) => c.jobs[job.id]);
  const steps: Step[] = job.steps.map((s) => ({ credential_id: s.credential_id, model: s.model }));
  const modelsOf = (credentialId: string) => data.connections.find((c) => c.id === credentialId)?.jobs[job.id];
  const firstModelOf = (credentialId: string) => {
    const m = modelsOf(credentialId);
    return m?.default_model && m.models.includes(m.default_model) ? m.default_model : (m?.models[0] ?? "");
  };
  const replace = (i: number, step: Step) => onSave(steps.map((s, j) => (j === i ? step : s)));
  const move = (i: number, by: -1 | 1) => onSave(movedStep(steps, i, i + by));
  const ids = steps.map((_, i) => `${job.id}-step-${i}`);
  const onDrop = (activeId: string, overId: string) => {
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from >= 0 && to >= 0 && from !== to) onSave(movedStep(steps, from, to));
  };
  const unused = able.find((c) => !steps.some((s) => s.credential_id === c.id)) ?? able[0];
  const marked = !!highlight && job.steps.some((s) => s.credential_id === highlight);
  // Quick look is asked at the camera: the picker steers to quick models.
  const noteFor = job.id === "glance" ? (id: string) => (slowForQuickLook(id) ? "slow for a quick look" : null) : undefined;
  const jobName = group.phrase;

  return (
    <div
      className={`py-3 ${marked ? "-mx-2 px-2 rounded-lg bg-accent/5 ring-2 ring-accent/50" : ""}`}
      data-job={job.id}
      data-highlighted={marked ? "true" : undefined}
    >
      {/* The whole row opens on a tap; its title is the button a keyboard and
          a screen reader use. A connection's name inside it marks instead. */}
      <div className="cursor-pointer" onClick={onToggle}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="min-w-0 text-left text-sm font-medium text-content dark:text-mortar-100 hover:underline"
          >
            {group.title}
          </button>
          {!readOnly && <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />}
        </div>
        {job.steps.length ? (
          <ol className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm" aria-label={`${group.title}: who answers, in order`}>
            {job.steps.map((s, i) => (
              <li key={`${i}-${s.credential_id}-${s.model}`} className="flex min-w-0 items-center gap-1.5">
                {i > 0 && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-label="then" />}
                <span className="min-w-0 break-words">
                  <button
                    type="button"
                    aria-pressed={highlight === s.credential_id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onHighlight(s.credential_id);
                    }}
                    className={`font-medium hover:underline ${highlight === s.credential_id ? "text-accent underline" : "text-content dark:text-mortar-100"}`}
                    data-connection={s.credential_id}
                  >
                    {s.label}
                  </button>
                  <span className="text-muted"> · {modelName(data, s)}</span>
                  {noteFor?.(s.model) && <span className="ml-1 text-[11px] text-amber-700 dark:text-amber-300">({noteFor(s.model)})</span>}
                  {!s.usable && <span className="ml-1 text-[11px] text-amber-700 dark:text-amber-300">(skipped: can't do this now)</span>}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-xs text-muted">
            {emptyText ?? (able.length ? "Each workspace uses its own." : "None of your connections can do this. Add one that can, above.")}
          </p>
        )}
        <div className="text-[11px] text-faint">If nothing answers, {group.waits}.</div>
      </div>
      {footer}
      {open && !readOnly && able.length > 0 && (
        <K.Root grip="pointer" onDrop={onDrop}>
          <K.Group ids={ids}>
            <ol className="mt-2 space-y-1.5" aria-label={`${group.title}: change the order and models`}>
              {job.steps.map((s, i) => {
                const m = modelsOf(s.credential_id);
                const labels = s.provider_id ? (data.model_labels[s.provider_id] ?? {}) : {};
                const known = m?.models.includes(s.model);
                const where = i === 0 ? "first" : `fallback ${i}`;
                return (
                  <li key={ids[i]}>
                    <K.Handled id={ids[i]!}>
                      {(grip) => (
                        <div className="flex flex-wrap items-center gap-1.5 rounded border border-line dark:border-slate-700 p-1.5">
                          {grip && (
                            <span {...grip} className="cursor-grab touch-none text-faint" aria-label={`Drag ${s.label} to reorder`} title={`Drag ${s.label} to reorder`} data-drag-step>
                              <GripVertical className="h-4 w-4" />
                            </span>
                          )}
                          <span className="w-10 shrink-0 text-[11px] text-faint">{i === 0 ? "First" : "Then"}</span>
                          <select
                            aria-label={`${group.title}: ${where} connection`}
                            value={s.credential_id}
                            disabled={pending}
                            onChange={(e) => replace(i, { credential_id: e.target.value, model: firstModelOf(e.target.value) })}
                            className={SELECT}
                          >
                            {!able.some((c) => c.id === s.credential_id) && <option value={s.credential_id}>{s.label}</option>}
                            {able.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label={`${group.title}: ${where} model`}
                            value={s.model}
                            disabled={pending}
                            onChange={(e) => replace(i, { credential_id: s.credential_id, model: e.target.value })}
                            className={SELECT}
                          >
                            {!known && <option value={s.model}>{modelName(data, s)}</option>}
                            {m?.choices ? (
                              <ModelChoiceOptions choices={m.choices} noteFor={noteFor} />
                            ) : (
                              [...(m?.models ?? [])]
                                .sort((a, b) => Number(!!noteFor?.(a)) - Number(!!noteFor?.(b)))
                                .map((id) => (
                                  <option key={id} value={id}>
                                    {modelWords(id, labels[id]) + (noteFor?.(id) ? ` (${noteFor(id)})` : "")}
                                  </option>
                                ))
                            )}
                          </select>
                          <VerificationBadge verification={verification(s.credential_id)} />
                          {/* The id itself, small, for someone matching it to a bill or a log. */}
                          <span className="basis-full pl-12 text-[10px] font-mono text-faint break-all" data-model-id>
                            {s.model}
                          </span>
                          <span className="ml-auto flex shrink-0 gap-0.5">
                            <button title={`Ask ${s.label} earlier for ${jobName}`} type="button" className={ICON_BUTTON} disabled={pending || i === 0} onClick={() => move(i, -1)} aria-label={`Ask ${s.label} earlier for ${jobName}`}>
                              <ArrowUp className="h-4 w-4" />
                            </button>
                            <button
                              title={`Ask ${s.label} later for ${jobName}`}
                              type="button"
                              className={ICON_BUTTON}
                              disabled={pending || i === job.steps.length - 1}
                              onClick={() => move(i, 1)}
                              aria-label={`Ask ${s.label} later for ${jobName}`}
                            >
                              <ArrowDown className="h-4 w-4" />
                            </button>
                            <button title={`Stop asking ${s.label} for ${jobName}`} type="button" className={ICON_BUTTON} disabled={pending} onClick={() => onSave(steps.filter((_, j) => j !== i))} aria-label={`Stop asking ${s.label} for ${jobName}`}>
                              <X className="h-4 w-4" />
                            </button>
                          </span>
                        </div>
                      )}
                    </K.Handled>
                  </li>
                );
              })}
              {unused && (
                <li>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onSave([...steps, { credential_id: unused.id, model: firstModelOf(unused.id) }])}
                    className="inline-flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {job.steps.length ? "Add a fallback" : firstText}
                  </button>
                </li>
              )}
            </ol>
          </K.Group>
        </K.Root>
      )}
      {job.own_order_in.map((o) => (
        <div key={o.org_id} className="mt-1 text-[11px] text-muted dark:text-slate-400">
          <WorkspaceLink slug={o.slug} to={`/configuration/ai#${WHO_ANSWERS_ANCHOR}`} className="font-medium text-content dark:text-mortar-200 hover:underline">
            {o.name}
          </WorkspaceLink>{" "}
          uses its own order
          {o.can_change && job.steps.length > 0 && (
            <>
              {" · "}
              <button type="button" disabled={pending} onClick={() => onUseMineThere(o.slug, o.capabilities)} className="text-accent hover:underline disabled:opacity-50">
                Use my defaults there
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
