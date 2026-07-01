// ONE AI-availability pattern for every surface (redesign proposal A1): tell
// the user the experience is degraded BEFORE they hit it, with a "connect"
// path — never silently degrade. Extracted from ScanPage (which pioneered it);
// the scan page, the homepage funnel, and /build all render this now.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { api, type AiStatus } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

/** Is AI usable for this workspace/user? Cached well beyond a session —
 *  availability only changes when someone reconfigures. */
export function useAiStatus(): AiStatus | null {
  const { activeSlug } = useActiveOrg();
  const q = useQuery({
    queryKey: ["ai-status", activeSlug],
    queryFn: () => api.getAiStatus(activeSlug),
    enabled: !!activeSlug,
    staleTime: 5 * 60_000,
  });
  return q.data ?? null;
}

/** The up-front "runs in basic mode" strip for AI-less workspaces. Body copy is
 *  per-surface via children (what "basic mode" MEANS differs between scanning,
 *  matching, and building); the shell, icon, and connect-link are shared. */
export function AiOffNotice({ status, compact, children }: { status: AiStatus | null; compact?: boolean; children?: ReactNode }) {
  if (!status || status.available) return null;
  return (
    <div
      className={
        "rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-content dark:text-mortar-100 flex items-start gap-2 " +
        (compact ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm")
      }
    >
      <Sparkles size={compact ? 13 : 15} className="text-amber-500 shrink-0 mt-0.5" />
      <div>
        {children ?? (
          <>
            <strong>AI isn't connected — scans run in basic mode.</strong> Known
            barcodes still get a catalog name + photo, but unknown ones won't be
            auto-named, brands won't fill in, and photo-only items won't be
            identified — you'll fill those fields in yourself.{" "}
          </>
        )}
        {status.reason === "operator_disabled" ? (
          <span className="text-muted dark:text-slate-400">
            (AI is switched off for this whole server.)
          </span>
        ) : (
          <Link to="/configuration/ai" className="text-accent hover:underline">
            Connect AI →
          </Link>
        )}
      </div>
    </div>
  );
}
