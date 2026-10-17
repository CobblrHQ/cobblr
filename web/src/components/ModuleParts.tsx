import { useMutation, useQueryClient } from "@tanstack/react-query";
import { changeWorkspaceShape, useToast } from "@cobblr/platform-web";
import { api, ApiError, type OrgModuleListItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
/** A module's parts, each turned on or off on its own. Off hides the part's
 *  screens, actions and tools and keeps everything it recorded. */
export function ModuleParts({ m }: { m: OrgModuleListItem }) {
  const qc = useQueryClient(), toast = useToast(), { activeSlug: slug } = useActiveOrg();
  const set = useMutation({
    mutationFn: ({ part, enabled }: { part: string; enabled: boolean | null }) => changeWorkspaceShape(qc, slug, () => api.setModulePart(slug, m.name, part, enabled)),
    onSuccess: (r, { part }) => { const label = m.parts?.find((p) => p.id === part)?.label ?? part; toast.success(r.part.on ? `${label} is on.` : `${label} is off. Everything it recorded is kept.`); },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't change that part."),
  });
  if (!m.enabled || !m.parts?.length) return null;
  return <fieldset className="mt-2 space-y-1" aria-label={`Parts of ${m.displayName}`}>
    <legend className="text-[10px] uppercase tracking-widest text-faint">Parts</legend>
    {m.parts.map((p) => <div key={p.id} className="flex flex-wrap items-center gap-2">
      <label className="flex min-h-11 items-center gap-2 text-xs text-content dark:text-mortar-200">
        <input type="checkbox" checked={p.on} disabled={set.isPending} onChange={(e) => set.mutate({ part: p.id, enabled: e.target.checked })} />
        <span className="font-medium">{p.label}</span>
      </label>
      <span className="text-[11px] text-faint dark:text-slate-500 flex-1 min-w-0">{p.description}{!p.chosen && p.default === "with-collection" ? " On with its collection." : ""}</span>
      {p.chosen && <button type="button" className="min-h-11 text-[10px] uppercase tracking-widest text-faint hover:text-accent px-2" disabled={set.isPending} onClick={() => set.mutate({ part: p.id, enabled: null })}>use default</button>}
    </div>)}
  </fieldset>;
}
