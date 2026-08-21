// Connected to Discord, and nothing will ever arrive there.
//
// The dispatcher's rule is that no matching subscription means in-app only, and
// it applies silently. So a person can connect Discord, verify it with a test
// DM, watch that DM arrive, and reasonably conclude notifications now reach
// them — while every notification goes to the bell and nowhere else. That
// exact state ran for weeks and was only found by asking why a parcel never
// announced itself.
//
// Deliberately not fixed by subscribing people automatically. A DM is an
// interruption, and quietly enrolling someone in interruptions because they
// linked an account is how a product loses the right to send them. So: say it,
// offer the one action that fixes it, and let it be chosen.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareOff } from "lucide-react";
import { ApiError, api, type NotificationChannelBinding } from "../lib/api";
import { useToast } from "@cobblr/platform-web";

export function DiscordUnsubscribedCallout({
  orgId,
  bindings,
}: {
  orgId: string;
  /** The workspace's existing bindings, already loaded by the page. */
  bindings: NotificationChannelBinding[] | undefined;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const discord = useQuery({
    queryKey: ["me-discord"],
    queryFn: () => api.meDiscordStatus(),
    staleTime: 60_000,
  });

  const subscribe = useMutation({
    mutationFn: () =>
      api.upsertMeNotificationChannel({
        org_id: orgId,
        // Everything, because the alternative is asking someone to predict
        // which event types they will care about before they have seen one.
        // Narrowing later is a row they can edit; never having been told is
        // not recoverable.
        event_type: "*",
        channel: "discord_dm",
        enabled: true,
        min_priority: "normal",
        config: {},
      }),
    onSuccess: () => {
      toast.success("Discord will get your notifications from now on.");
      void qc.invalidateQueries({ queryKey: ["notification-channels", orgId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not set that up."),
  });

  // Only the state this exists for: a working link with nothing routed to it.
  // Not connected is the connect screen's business, and an existing binding
  // means the question is already answered.
  if (!discord.data?.verified) return null;
  if (bindings === undefined) return null;
  if (bindings.some((b) => b.channel === "discord_dm")) return null;

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-mortar-100">
        <MessageSquareOff size={15} className="text-amber-600 dark:text-amber-400 shrink-0" aria-hidden />
        Discord is connected, but nothing is sent there
      </div>
      <p className="text-[13px] text-muted">
        Connecting Discord proves we can reach you. It does not decide what to send. Until something
        below is bound to Discord, this workspace&apos;s notifications only appear in the bell.
      </p>
      <button
        type="button"
        disabled={subscribe.isPending}
        onClick={() => subscribe.mutate()}
        className="rounded bg-cobble-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
      >
        {subscribe.isPending ? "Setting up…" : "Send this workspace's notifications to Discord"}
      </button>
    </div>
  );
}
