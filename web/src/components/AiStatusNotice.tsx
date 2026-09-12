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

export type AiNeeds = "chat" | "identify";

/** The one sentence about AI for this workspace, and the one link that goes
 *  with it. Null when there is nothing to say (AI works, or the surface only
 *  needs identification and that works).
 *
 *  This is THE resolver. Before it, every surface phrased the state on its own
 *  and the reason-specific line was appended after the surface's copy, so the
 *  first-task panel said "Connect a free model to use the builder" and then
 *  "(AI is switched off for this whole server.)" in the same breath, with a
 *  connect link that led nowhere the operator would let it (review finding
 *  WEB-04). Now a reason the surface cannot speak to supplies the whole
 *  sentence; only "nothing is connected yet" lets the surface say what basic
 *  mode means there.
 *
 *  `text` null means: the surface's own copy applies (no_provider only). */
export function aiStatusLine(
  status: AiStatus | null,
  needs: AiNeeds = "chat",
): { text: ReactNode | null; cta: { to: string; label: string } | null } | null {
  if (!status || status.available) return null;
  if (needs === "identify" && status.identify_available) return null;
  switch (status.reason) {
    case "operator_disabled":
      // Off for everyone on this deployment. No connect path: there is
      // nothing the person can connect that the operator has not switched off.
      return {
        text: (
          <>
            <strong>AI is off here.</strong> Barcodes, ISBNs and typed items still work.{" "}
          </>
        ),
        cta: null,
      };
    case "workspace_disabled":
      // Off BECAUSE SOMEONE TURNED IT OFF is a different sentence from off because
      // nothing is connected, and it wants a different verb on the link. This one
      // caught a real case: AI switched off for a workspace showed "AI isn't
      // connected - Connect AI", sending an owner to add a provider they had
      // already added.
      return {
        text: (
          <>
            <strong>AI is turned off for this workspace.</strong> Turn it back on to identify
            things from a photo and to use the builder.{" "}
          </>
        ),
        cta: { to: "/configuration/ai", label: "Turn AI on \u2192" },
      };
    case "not_entitled":
      // The plan does not include it, but a person can bring their own model.
      return {
        text: (
          <>
            <strong>This workspace's plan doesn't include AI.</strong> Everything else works;
            connect a model of your own to use it here.{" "}
          </>
        ),
        cta: { to: "/me/connections", label: "Connect your own \u2192" },
      };
    default:
      return { text: null, cta: { to: "/configuration/ai", label: "Connect AI \u2192" } };
  }
}

/** The up-front "runs in basic mode" strip for AI-less workspaces. Body copy is
 *  per-surface via children (what "basic mode" MEANS differs between scanning,
 *  matching, and building) and applies only when nothing is connected yet; the
 *  shell, icon, sentence and link come from aiStatusLine. */
export function AiOffNotice({
  status,
  compact,
  children,
  needs = "chat",
}: {
  status: AiStatus | null;
  compact?: boolean;
  children?: ReactNode;
  /** What this SURFACE actually needs. A scan surface needs identification,
   *  which a deployment can provide through the hosted service with no chat
   *  provider connected at all - so "AI isn't connected" is simply false there,
   *  and it was being shown in the try sandbox while photo identification was
   *  working. A surface that needs a MODEL (the builder, the assistant) keeps
   *  the default and still warns. */
  needs?: AiNeeds;
}) {
  const line = aiStatusLine(status, needs);
  if (!line) return null;
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
      <CobbHead size={compact ? 18 : 22} className="shrink-0 mt-0.5" title="Cobb" />
      <div>
        {/* A reason the SURFACE cannot speak to supplies the whole sentence (see
            aiStatusLine); the surface's children apply only when nothing is
            connected yet. */}
        {line.text ?? children ?? (
          <>
            <strong>AI isn't connected - scans run in basic mode.</strong> Known
            barcodes still get a catalog name + photo, but unknown ones won't be
            auto-named, brands won't fill in, and photo-only items won't be
            identified - you'll fill those fields in yourself.{" "}
          </>
        )}
        {line.cta && (
          <Link to={line.cta.to} className="text-accent hover:underline">
            {line.cta.label}
          </Link>
        )}
      </div>
    </div>
  );
}
