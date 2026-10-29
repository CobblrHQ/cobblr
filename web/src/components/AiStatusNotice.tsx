// ONE AI-availability pattern for every surface (redesign proposal A1): tell
// the user the experience is degraded BEFORE they hit it, with a "connect"
// path — never silently degrade. Extracted from ScanPage (which pioneered it);
// the scan page, the homepage funnel, and /build all render this now.
import { aiAvailabilityKeys } from "../lib/ai-availability-keys";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { mayRead } from "../lib/acting-role";
import { Link } from "react-router-dom";
import { CobbHead } from "./CobbHead";
import { X } from "lucide-react";
import { api, type AiStatus } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

/** Is AI usable for this workspace/user? Cached well beyond a session —
 *  availability only changes when someone reconfigures. */
function useAiStatusQuery() {
  const { activeSlug } = useActiveOrg();
  return useQuery({
    queryKey: aiAvailabilityKeys.status(activeSlug),
    queryFn: () => api.getAiStatus(activeSlug),
    enabled: !!activeSlug && mayRead(`/orgs/${activeSlug}/ai-status`),
    staleTime: 5 * 60_000,
  });
}
export function useAiStatus(): AiStatus | null {
  return useAiStatusQuery().data ?? null;
}
/** Whether the status has answered (or failed, or will never be asked): a
 *  page that draws its notice with the rest waits on this, not on a status. */
export function useAiStatusAnswered(): boolean {
  return !useAiStatusQuery().isLoading;
}

export type AiNeeds = "chat" | "identify";

/** What AI this workspace can actually use, on the two axes that differ.
 *  `chat` is a model for the assistant and the builder. `identify` is reading
 *  a photo, which a deployment can serve with no chat model at all (its own
 *  hosted identify service), or a provider with the image capability can.
 *
 *  Every notice and every AI button reads THIS, never `status.available`
 *  alone: that is the chat axis, and a sandbox whose photo identify worked
 *  was told "AI is off here" beside a disabled Re-run. Null status means not
 *  answered yet, which reads as usable so nothing greys out in the meantime. */
export function aiReach(status: AiStatus | null): { chat: boolean; identify: boolean } {
  if (!status) return { chat: true, identify: true };
  return { chat: status.available, identify: status.available || !!status.identify_available };
}

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
  const reach = aiReach(status);
  if (!status || reach.chat) return null;
  if (needs === "identify" && reach.identify) return null;
  if (needs === "identify" && status.identify_reason === "hosted_scope" && status.reason !== "operator_disabled") {
    // The deployment reads photos for free, just not for this workspace.
    // "AI isn't connected" would send an admin to set up what is already
    // there; what works is a connection of the person's own.
    return {
      text: (
        <>
          <strong>Free photo identify here covers other workspaces, not this one.</strong> Barcodes,
          ISBNs and typed items still work. Connect your own AI to read photos here.{" "}
        </>
      ),
      cta: { to: "/me/connections", label: "Connect your own \u2192" },
    };
  }
  switch (status.reason) {
    case "operator_disabled":
      if (reach.identify) {
        // Chat is off for the deployment, but photos are still read here. "AI
        // is off" would be false on the very screen that just named a photo.
        return {
          text: (
            <>
              <strong>Chat with Cobb is off here.</strong> Photo identify, barcodes, ISBNs and
              typed items all work.{" "}
            </>
          ),
          cta: null,
        };
      }
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
    case "not_shared":
      // AI is here, connected "Just me" by someone else: not the plan, not an
      // allowance (#8855). They can share it; this person can bring their own.
      return {
        text: (
          <>
            <strong>AI here is {status.kept_by ?? "someone else"}'s own connection.</strong> It answers only
            their calls. Ask them to share it with the workspace, or connect your own.{" "}
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
  ctaLabel,
  dismissible,
}: {
  status: AiStatus | null;
  compact?: boolean;
  children?: ReactNode;
  /** The link's words when nothing is connected yet, said for this surface
   *  ("Connect AI for the builder and Cobb"); a reason with its own sentence
   *  keeps its own link. */
  ctaLabel?: string;
  /** A key this browser remembers the notice was put away under: a first
   *  screen that says it once lets the person close it (#7199). */
  dismissible?: string;
  /** What this SURFACE actually needs. A scan surface needs identification,
   *  which a deployment can provide through the hosted service with no chat
   *  provider connected at all - so "AI isn't connected" is simply false there,
   *  and it was being shown in the try sandbox while photo identification was
   *  working. A surface that needs a MODEL (the builder, the assistant) keeps
   *  the default and still warns. */
  needs?: AiNeeds;
}) {
  const line = aiStatusLine(status, needs);
  const given = useContext(AiNoticeGivenContext);
  const [hidden, setHidden] = useState(() => {
    if (!dismissible) return false;
    try {
      return localStorage.getItem(dismissible) === "1";
    } catch {
      return false;
    }
  });
  if (!line || hidden) return null;
  // Said once already on this screen: keep only what is particular to this
  // surface, as a quiet line, never a second banner (#4146: the scan page and
  // the put-away plan inside it both showed "plan doesn't include AI").
  const fact = needs === "identify" && status?.identify_reason === "hosted_scope" && status.reason !== "operator_disabled"
    ? "hosted_scope" : status?.reason;
  if (given.all || (fact && given.reasons.has(fact))) {
    return !line.text && children ? <p className="text-xs text-muted dark:text-slate-400">{children}</p> : null;
  }
  return (
    <div
      data-notice="ai-off"
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
          <Link to={line.cta.to} className="text-accent underline underline-offset-2 hover:no-underline">
            {!line.text && ctaLabel ? ctaLabel : line.cta.label}
          </Link>
        )}
      </div>
      {dismissible && (
        <button
          type="button"
          aria-label="Hide this notice"
          title="Hide this notice"
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem(dismissible, "1");
            } catch {
              /* a private window keeps it closed for this visit only */
            }
          }}
          className="ml-auto shrink-0 rounded p-0.5 text-faint hover:text-content"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

const AiNoticeGivenContext = createContext<{ all: boolean; reasons: ReadonlySet<string> }>({ all: false, reasons: new Set() });

/** Wrap what sits below a page's own AI notice: a notice inside does not
 *  repeat it. `when` is whether the notice actually showed. `reason` limits
 *  suppression to that fact; nested pages keep the parent scope. */
export function AiNoticeGiven({ when, reason, children }: { when: boolean; reason?: AiStatus["reason"]; children: ReactNode }) {
  const parent = useContext(AiNoticeGivenContext);
  const value = useMemo(() => ({
    all: parent.all || (when && !reason),
    reasons: new Set([...parent.reasons, ...(when && reason ? [reason] : [])]),
  }), [parent, when, reason]);
  return <AiNoticeGivenContext.Provider value={value}>{children}</AiNoticeGivenContext.Provider>;
}
