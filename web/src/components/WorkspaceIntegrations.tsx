import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { changeWorkspaceShape, useToast } from "@cobblr/platform-web";
import { api } from "../lib/api";

export function WorkspaceIntegrations({ slug, name, canEnable, offers }: { slug: string; name: string; canEnable: boolean; offers: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const modules = useQuery({ queryKey: ["org-modules", slug], queryFn: () => api.orgModules(slug) });
  const turnOn = useMutation({
    mutationFn: (module: string) => changeWorkspaceShape(qc, slug, () => api.enableModule(slug, module)),
    onSuccess: (result, module) => {
      const label = modules.data?.items.find((m) => m.name === module)?.displayName ?? module;
      if (result.already_enabled) return;
      toast.action(`Turned on ${label} for ${name}.`, {
        actionLabel: "Undo",
        onAction: async () => {
          try {
            await changeWorkspaceShape(qc, slug, () => api.disableModule(slug, module));
            toast.success(`${label} turned off. Your data stays.`);
          } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn't undo that."); }
        },
      });
    },
  });
  const integrations = (modules.data?.items ?? []).filter((m) => m.integration && (m.enabled || offers));
  if (!integrations.length) return null;
  return <section className="space-y-2" aria-label={`Services for ${name}`}>
    <h2 className="text-sm font-mono uppercase tracking-widest text-accent">Services for {name}</h2>
    {integrations.map((m) => <div key={m.name} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3">
      <div className="font-medium">{m.displayName}</div>
      <p className="text-sm text-muted dark:text-slate-400">{m.description}</p>
      {m.enabled ? <Link to={m.integration!.route} className="text-sm text-accent hover:underline">Open {m.displayName}</Link>
        : canEnable && <button type="button" disabled={turnOn.isPending} onClick={() => turnOn.mutate(m.name)} className="mt-2 rounded border border-line dark:border-slate-700 px-3 py-1.5 text-sm hover:text-accent">Turn on {m.displayName}</button>}
    </div>)}
    {turnOn.error && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{turnOn.error.message}</p>}
  </section>;
}
