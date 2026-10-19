// The versions view (#6887): a collection's machines by cohort (a model on one
// firmware family), each counted current, behind or unknown against the
// version an admin set for the cohort. A version nobody has seen lately is
// unknown, never current; the server judges, this page only shows.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { headerButton, relativeTime, useToast } from "@cobblr/platform-web";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { api, type Machine, type MachineVersionCohort, type MachineVersionReading, type MachineVersionStatus } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { MetaParts, joinMeta } from "./MetaParts";
import { LocationTreePicker } from "./LocationTreePicker";

const STATUS: Record<MachineVersionStatus, { word: string; cls: string }> = {
  current: { word: "current", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  behind: { word: "behind", cls: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  unknown: { word: "unknown", cls: "bg-subtle text-muted dark:bg-slate-800 dark:text-slate-400" },
};

/** "6.1.3 · reported 2h ago", or why it does not count. */
export function readingLine(r: MachineVersionReading): string {
  if (!r.version) return "not known";
  const how = r.source === "reported" ? "reported" : r.source === "typed" ? "typed" : "";
  const when = relativeTime(r.seen_at);
  if (!r.fresh) return joinMeta([r.version, `not seen since ${when || "ever"}`]);
  return joinMeta([r.version, [how, when].filter(Boolean).join(" ")]);
}

function StatusPill({ status }: { status: MachineVersionStatus | null }) {
  if (!status) return null;
  const s = STATUS[status];
  return <span className={`text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded ${s.cls}`}>{s.word}</span>;
}

function TargetForm({ slug, instance, cohort, onDone }: { slug: string; instance?: string; cohort: MachineVersionCohort; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [firmware, setFirmware] = useState(cohort.target?.firmware_target ?? cohort.versions.find((v) => v.field === "firmware")?.version ?? "");
  const [software, setSoftware] = useState(cohort.target?.software_target ?? "");
  const save = useMutation({
    mutationFn: (body: { firmware_target: string | null; software_target: string | null }) => api.setMachineVersionTarget(slug, { cohort: cohort.label, ...body }, instance),
    onSuccess: (out) => {
      toast.success(out.summary);
      void qc.invalidateQueries({ queryKey: ["machine-versions", slug, instance ?? null] });
      onDone();
    },
  });
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ firmware_target: firmware.trim() || null, software_target: software.trim() || null });
      }}
    >
      <label className="text-xs text-muted flex flex-col gap-1 max-sm:w-full">
        Firmware should be
        <input className="input !h-9 sm:w-36" value={firmware} onChange={(e) => setFirmware(e.target.value)} placeholder="e.g. 6.1.3" aria-label={`Firmware target for ${cohort.label}`} />
      </label>
      <label className="text-xs text-muted flex flex-col gap-1 max-sm:w-full">
        Software should be
        <input className="input !h-9 sm:w-36" value={software} onChange={(e) => setSoftware(e.target.value)} placeholder="optional" aria-label={`Software target for ${cohort.label}`} />
      </label>
      <div className="flex gap-2 max-sm:w-full">
        <button type="submit" className={`${headerButton("primary")} max-sm:flex-1`} disabled={save.isPending}>Save target</button>
        <button type="button" className={`${headerButton()} max-sm:flex-1`} onClick={onDone}>Cancel</button>
        {cohort.target && (
          <button type="button" className={`${headerButton()} max-sm:flex-1`} disabled={save.isPending} onClick={() => save.mutate({ firmware_target: null, software_target: null })}>
            Clear
          </button>
        )}
      </div>
      {save.error && <p className="w-full text-xs text-red-600 dark:text-red-400" role="alert">{(save.error as Error).message}</p>}
    </form>
  );
}

function CohortCard({ slug, instance, cohort, canSet, onOpen }: { slug: string; instance?: string; cohort: MachineVersionCohort; canSet: boolean; onOpen: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const wants = joinMeta([cohort.target?.firmware_target && `firmware ${cohort.target.firmware_target}`, cohort.target?.software_target && `software ${cohort.target.software_target}`]);
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3" data-testid="version-cohort" aria-label={cohort.label}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">{cohort.label}</h3>
        <span className="text-sm font-semibold" data-testid="cohort-summary">{cohort.summary}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>{wants ? `Target: ${wants}` : "No target set"}</span>
        {wants && <span><MetaParts parts={[`${cohort.behind} behind`, `${cohort.unknown} unknown`]} /></span>}
        {cohort.down_for_repair > 0 && <span className="text-amber-700 dark:text-amber-300">{cohort.down_for_repair} down for repair</span>}
        {canSet && !editing && (
          <button type="button" className="text-accent hover:underline" onClick={() => setEditing(true)}>
            {cohort.target ? "Change target" : "Set target"}
          </button>
        )}
      </div>
      {editing && <TargetForm slug={slug} instance={instance} cohort={cohort} onDone={() => setEditing(false)} />}
      {cohort.versions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {cohort.versions.map((v) => (
            <span key={`${v.field}:${v.version}`} className="text-[11px] px-2 py-0.5 rounded-full border border-line dark:border-slate-700">
              {v.field} {v.version} <span className="text-faint">×{v.machines}</span>
            </span>
          ))}
        </div>
      )}
      <ul className="mt-2 divide-y divide-line dark:divide-slate-800">
        {cohort.items.map((m) => (
          <li key={m.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button type="button" className="text-sm text-left hover:text-accent min-w-0 flex-1 basis-40 truncate" onClick={() => onOpen(m.id)}>
              {m.name}
              {m.count > 1 && <span className="text-faint"> ×{m.count}</span>}
              {m.where && <span className="block text-[11px] text-faint truncate">{m.where}</span>}
            </button>
            <span className="text-xs text-muted basis-48 max-sm:basis-full">
              Firmware {readingLine(m.firmware)}
              {m.software.version && <span className="block">Software {readingLine(m.software)}</span>}
            </span>
            <span className="flex items-center gap-1.5">
              {m.down_for_repair && <span className="text-[10px] uppercase tracking-widest text-amber-700 dark:text-amber-300">down</span>}
              <StatusPill status={m.status} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MachineVersions({ slug, instance, noun, onOpen }: { slug: string; instance?: string; noun: string; onOpen: (id: string) => void }) {
  const { activeOrg } = useActiveOrg();
  const [place, setPlace] = useState<string>("");
  const fleet = useQuery({
    queryKey: ["machine-versions", slug, instance ?? null, place],
    queryFn: () => api.getMachineVersions(slug, instance, place || null),
    enabled: !!slug,
  });
  const canSet = roleSatisfies(activeOrg?.role, ["owner", "admin"]);
  if (fleet.isLoading) return <div className="text-xs text-faint px-1 py-6">Reading versions…</div>;
  if (fleet.error) return <div className="text-xs text-red-600 dark:text-red-400 px-1 py-6" role="alert">{(fleet.error as Error).message}</div>;
  const data = fleet.data!;
  const t = data.totals;
  return (
    <div className="space-y-3" data-testid="machine-versions">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm" data-testid="versions-totals">
          <span className="font-semibold">{t.current} of {t.machines}</span> current
          <span className="text-muted"> · <MetaParts parts={[`${t.behind} behind`, `${t.unknown} unknown`, t.down_for_repair > 0 && `${t.down_for_repair} down for repair`]} /></span>
        </p>
        <div className="max-sm:w-full sm:w-56">
          <LocationTreePicker value={place || null} onChange={(id) => setPlace(id ?? "")} placeholder="Everywhere" noneLabel="Everywhere" size="sm" />
        </div>
      </div>
      {data.cohorts.length === 0 ? (
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-10 text-center text-xs text-faint italic">
          No {noun} here yet.
        </div>
      ) : (
        data.cohorts.map((c) => <CohortCard key={c.cohort} slug={slug} instance={instance} cohort={c} canSet={canSet} onOpen={onOpen} />)
      )}
      <p className="text-[11px] text-faint">
        A version a machine reported in the last 7 days, or one typed in the last 90, counts. Anything older is unknown until the machine says it again or someone types it.
      </p>
    </div>
  );
}

/** Under a machine's own fields: where its versions came from and when they
 *  were last seen, so a typed "6.1.3" from last spring reads as that. */
export function VersionProvenance({ machine: m }: { machine: Machine }) {
  const said = (what: string, version: string | null | undefined, source: string | null | undefined, seen: string | null | undefined) =>
    version && source ? `${what} ${source === "reported" ? "reported by the machine" : "typed"} ${relativeTime(seen)}` : null;
  const firmware = said("Firmware", m.firmware_version, m.firmware_source, m.firmware_seen_at);
  const software = said("Software", m.software_version, m.software_source, m.software_seen_at);
  if (!firmware && !software) return null;
  return (
    <p className="text-[11px] text-faint" data-testid="version-provenance">
      <MetaParts parts={[firmware, software]} />
    </p>
  );
}
