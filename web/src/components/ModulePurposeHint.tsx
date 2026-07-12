import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

/** A one-line "what is this tab for?" banner for a module's empty state.
 *  Surfaces the module's OWN manifest `description` so a user landing on a
 *  fresh module page understands its purpose without guessing. Generic across
 *  every module — pass the module name; it reads the enabled-modules list
 *  (cached) and renders nothing until a description is available, so it's safe
 *  to drop into any page's empty state. Motivated by feedback: the Purchases
 *  tab's purpose was unclear on an empty workspace. */
export function ModulePurposeHint({
  moduleName,
  className,
}: {
  moduleName: string;
  className?: string;
}) {
  const { activeSlug } = useActiveOrg();
  const modules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const mod = modules.data?.items.find((m) => m.name === moduleName);
  const description = mod?.description?.trim();
  if (!description) return null;

  return (
    <div
      className={
        "flex items-start gap-2.5 rounded-xl border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 px-4 py-3 " +
        (className ?? "")
      }
    >
      <Info size={16} className="mt-0.5 flex-none text-accent" />
      <p className="text-sm text-muted dark:text-slate-300">
        <span className="font-medium text-content dark:text-mortar-100">
          What’s {mod?.displayName ?? "this"} for?
        </span>{" "}
        {description}
      </p>
    </div>
  );
}
