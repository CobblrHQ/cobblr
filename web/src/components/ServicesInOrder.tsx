// The outside services under "Who does what, in order" (services.md sections
// 7 and 9): per capability, who answers first, your own connections movable,
// and the workspace's say over whether it asks first. Absent entirely when no
// service is connected here, which is most workspaces.
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type ServiceCapabilityView } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { movedOwnService, policyChoices, serviceSourceWords } from "../lib/service-order";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

const EFFECT_WORDS: Record<string, string> = {
  none: "changes nothing outside the service",
  writes: "changes something you own elsewhere",
  spends: "costs money",
  physical: "acts in the physical world",
};

export function ServicesInOrder() {
  const { activeSlug, activeOrg } = useActiveOrg();
  const caps = useQuery({
    queryKey: ["services-capabilities", activeSlug],
    queryFn: () => api.listServiceCapabilities(activeSlug),
    enabled: !!activeSlug,
    // A kernel without Services answers an error; that reads as "none here".
    retry: false,
  });
  const policies = useQuery({
    queryKey: ["services-policies", activeSlug],
    queryFn: () => api.getServicePolicies(activeSlug),
    enabled: !!activeSlug && !!caps.data?.items.length,
  });
  const items = caps.data?.items ?? [];
  if (!items.length) return null;
  const canSet = roleSatisfies(activeOrg?.role, ["admin"]);
  const policyOf = (id: string) => policies.data?.items.find((p) => p.capability === id)?.policy ?? "default";

  return (
    <div className="mt-5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent">Services</h3>
        <span className="flex-1" />
        <Link to="/services/runs" className="text-xs text-accent hover:underline">
          Recent runs →
        </Link>
      </div>
      <div className="mt-1 space-y-4">
        {items.map((c) => (
          <ServiceChain key={c.id} capability={c} policy={policyOf(c.id)} canSet={canSet} slug={activeSlug} orgId={activeOrg?.id ?? null} />
        ))}
      </div>
    </div>
  );
}

function ServiceChain({
  capability: c,
  policy,
  canSet,
  slug,
  orgId,
}: {
  capability: ServiceCapabilityView;
  policy: string;
  canSet: boolean;
  slug: string;
  orgId: string | null;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e));
  const move = useMutation({
    mutationFn: async (next: string[]) => {
      if (orgId) await api.setConnectionOrder({ org_id: orgId, credential_ids: next, capability: c.id });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["services-capabilities", slug] }),
    onError,
  });
  const setPolicy = useMutation({
    mutationFn: (p: "default" | "always_ask" | "run" | "off") => api.setServicePolicy(slug, c.id, p),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["services-policies", slug] }),
    onError,
  });
  const steps = c.answered_by;
  const choices = policyChoices(c.effect);

  return (
    <div data-service-capability={c.id}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm text-content dark:text-mortar-100">{c.title}</span>
        <span className="text-[11px] font-mono text-faint">{c.id}</span>
      </div>
      <p className="text-[11px] text-muted">{EFFECT_WORDS[c.effect] ?? c.effect}</p>
      {steps.length === 0 ? (
        <p className="text-sm text-muted mt-1">Nothing here can do this yet.</p>
      ) : (
        <ol className="mt-1 divide-y divide-line dark:divide-slate-700 rounded-lg border border-line dark:border-slate-700">
          {steps.map((s, i) => {
            const up = s.credential_id ? movedOwnService(steps, s.credential_id, -1) : null;
            const down = s.credential_id ? movedOwnService(steps, s.credential_id, 1) : null;
            return (
              <li key={`${i}-${s.label}`} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="w-5 shrink-0 text-faint tabular-nums">{i + 1}.</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-content dark:text-mortar-100">{s.label}</span>
                  <span className="block text-[11px] text-muted">{serviceSourceWords(s.scope)}</span>
                </span>
                {s.scope === "personal" && (up || down) && (
                  <span className="flex shrink-0 gap-0.5">
                    <button
                      title={`Ask ${s.label} earlier for ${c.title}`}
                      type="button"
                      disabled={!up || move.isPending}
                      onClick={() => up && move.mutate(up)}
                      aria-label={`Ask ${s.label} earlier for ${c.title}`}
                      className="p-1.5 rounded text-muted hover:text-content hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-30"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      title={`Ask ${s.label} later for ${c.title}`}
                      type="button"
                      disabled={!down || move.isPending}
                      onClick={() => down && move.mutate(down)}
                      aria-label={`Ask ${s.label} later for ${c.title}`}
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
      <label className="mt-1.5 flex items-center gap-2 text-[12px] text-muted">
        <span>In this workspace</span>
        {canSet ? (
          <select
            value={policy}
            disabled={setPolicy.isPending}
            onChange={(e) => setPolicy.mutate(e.target.value as "default" | "always_ask" | "run" | "off")}
            className="rounded border border-line dark:border-slate-700 bg-transparent px-1.5 py-0.5"
          >
            {choices.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span>{choices.find((o) => o.value === policy)?.label ?? policy}</span>
        )}
      </label>
    </div>
  );
}
