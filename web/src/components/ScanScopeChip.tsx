// The scan scope, named and droppable (#6892): "Scanning within Widget X ✕"
// on the camera and wherever a scanner types into the app. One tap clears it;
// it is gone with the session anyway (lib/scanScope.ts).
import { Crosshair, X } from "lucide-react";
import { setScanScope, useScanScope } from "../lib/scanScope";

/** `slug`: the workspace the surface is scanning in, from the surface that
 *  already knows it, so the chip adds no context of its own to need. */
export function ScanScopeChip({ slug, tone = "plain" }: { slug: string; tone?: "plain" | "camera" }) {
  const activeSlug = slug;
  const scope = useScanScope(activeSlug);
  if (!scope) return null;
  return (
    <span
      data-testid="scan-scope-chip"
      className={
        "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full pl-3 pr-1 text-xs font-medium " +
        (tone === "camera" ? "bg-black/60 text-white" : "border border-line bg-surface text-content shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-mortar-100")
      }
    >
      <Crosshair size={13} aria-hidden className="shrink-0" />
      <span className="truncate">Scanning within {scope.label}</span>
      <button
        type="button"
        onClick={() => setScanScope(activeSlug, null)}
        aria-label={`Stop scanning within ${scope.label}`}
        title={`Stop scanning within ${scope.label}: scan the whole workspace again`}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
      >
        <X size={14} aria-hidden />
      </button>
    </span>
  );
}
