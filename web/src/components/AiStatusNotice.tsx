// ONE AI-availability pattern for every surface (redesign proposal A1): tell
// the user the experience is degraded BEFORE they hit it, with a "connect"
// path — never silently degrade. Extracted from ScanPage (which pioneered it);
// the scan page, the homepage funnel, and /build all render this now.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CobbHead } from "./Cobb";
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
  // Off BECAUSE SOMEONE TURNED IT OFF is a different sentence from off because nothing
  // is connected, and it wants a different verb on the link. This one caught a real
  // case: AI switched off for a workspace showed "AI isn't connected - Connect AI",
  // sending an owner to add a provider they had already added.
  const reasonCopy =
    status.reason === "workspace_disabled" ? (
      <>
        <strong>AI is turned off for this workspace.</strong> Turn it back on to identify
        things from a photo and to use the builder.{" "}
      </>
    ) : status.reason === "not_entitled" ? (
      <>
        <strong>This workspace's plan doesn't include AI.</strong> Everything else works;
        scanning files things by keyword.{" "}
      </>
    ) : null;
  const cta =
    status.reason === "workspace_disabled"
      ? { to: "/configuration/ai", label: "Turn AI on \u2192" }
      : status.reason === "not_entitled"
        ? null
        : { to: "/configuration/ai", label: "Connect AI \u2192" };
  return (
    <div
      className={
        "rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-content dark:text-mortar-100 flex items-start gap-2 " +
        (compact ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm")
      }
    >
      {/* The RESTING head, not a generic sparkle. The illustrator drew this
          state for exactly this moment: Cobb is off the clock because no AI is
          connected, greyed rather than absent, so the notice reads as "he can't
          do that here" instead of a system warning about a feature. */}
      <CobbHead size={compact ? 18 : 22} sleeping className="shrink-0 mt-0.5" title="Cobb is resting" />
      <div>
        {/* A reason the SURFACE cannot speak to overrides its copy. Every caller passes
            children explaining what basic mode means there ("scans run in basic mode"),
            and all of that copy assumes nothing is connected. When AI is connected and
            merely switched off, or the plan excludes it, "connect a model" is wrong
            advice and the link points at the wrong action. */}
        {reasonCopy ?? children ?? (
          <>
            <strong>AI isn't connected - scans run in basic mode.</strong> Known
            barcodes still get a catalog name + photo, but unknown ones won't be
            auto-named, brands won't fill in, and photo-only items won't be
            identified - you'll fill those fields in yourself.{" "}
          </>
        )}
        {status.reason === "operator_disabled" ? (
          <span className="text-muted dark:text-slate-400">
            (AI is switched off for this whole server.)
          </span>
        ) : cta ? (
          <Link to={cta.to} className="text-accent hover:underline">
            {cta.label}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
