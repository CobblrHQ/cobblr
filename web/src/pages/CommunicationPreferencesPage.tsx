// /me/communication — account-level Communication Preferences (Feature 1).
//
// A matrix: notification types (rows) × channels (columns: In-app · Discord DM ·
// Email). Tier-1 critical types are shown LOCKED ("Always email"). Tier-2 types
// are checkboxes that write notification_account_prefs. The Discord DM column
// only appears once the user has connected + verified Discord — verification is
// a real test DM the bot sends (button confirm or website fallback), so we never
// rely on a DM channel blind.

import { PushNotificationsCard } from "../components/PushNotificationsCard";
import { useEffect, useState } from "react";
import { AreaTabs, NOTIFICATION_TABS } from "../components/AreaTabs";
import { DeliveryWindows } from "../components/DeliveryWindows";
import { useLocation, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Lock, MessageCircle } from "lucide-react";
import { usePageTitle, useToast, useConfirm } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { discordConnectable } from "../lib/discord-connect";
import { useDiscordStatus } from "../lib/useDiscordStatus";

const CHANNEL_LABEL: Record<string, string> = {
  in_app: "In-app",
  discord_dm: "Discord DM",
  email: "Email",
};

export function CommunicationPreferencesPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  // post-OAuth status: pending (test DM sent) | blocked (DM bounced) | error
  const discordParam = params.get("discord");

  const prefsQ = useQuery({ queryKey: ["comm-prefs"], queryFn: () => api.meCommunicationPrefs() });
  const discordQ = useDiscordStatus();

  const setPref = useMutation({
    mutationFn: (b: { notification_type: string; channel: string; enabled: boolean }) =>
      api.setMeCommunicationPref(b),
    onMutate: async (b) => {
      await qc.cancelQueries({ queryKey: ["comm-prefs"] });
      const prev = qc.getQueryData(["comm-prefs"]) as Awaited<ReturnType<typeof api.meCommunicationPrefs>> | undefined;
      if (prev) {
        qc.setQueryData(["comm-prefs"], {
          ...prev,
          prefs: { ...prev.prefs, [b.notification_type]: { ...prev.prefs[b.notification_type], [b.channel]: b.enabled } },
        });
      }
      return { prev };
    },
    onError: (err, _b, ctx) => {
      if (ctx?.prev) qc.setQueryData(["comm-prefs"], ctx.prev);
      toast.error(err instanceof ApiError ? err.message : "Couldn't save that preference.");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["comm-prefs"] }),
  });

  const connect = useMutation({
    mutationFn: () => api.meDiscordOAuthStart(),
    onSuccess: ({ url }) => { window.location.href = url; },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Discord isn't available right now."),
  });
  const confirmReceipt = useMutation({
    mutationFn: () => api.meDiscordConfirm(),
    onSuccess: () => { toast.success("Discord connected."); clearDiscordParam(); qc.invalidateQueries({ queryKey: ["discord-status"] }); qc.invalidateQueries({ queryKey: ["comm-prefs"] }); },
    onError: () => toast.error("Connect Discord first."),
  });
  const retryTest = useMutation({
    mutationFn: () => api.meDiscordRetryTest(),
    onSuccess: ({ deliverable }) =>
      deliverable
        ? toast.success("Test DM sent - check Discord.")
        : toast.error("Still can't DM you - adjust Discord privacy settings or join our server."),
    onError: (e: unknown) => toast.error(`Couldn't send the test DM: ${e instanceof ApiError ? e.message : String(e)}`),
  });
  const disconnect = useMutation({
    mutationFn: () => api.meDiscordDisconnect(),
    onSuccess: () => { toast.success("Discord disconnected."); qc.invalidateQueries({ queryKey: ["discord-status"] }); qc.invalidateQueries({ queryKey: ["comm-prefs"] }); },
    onError: (e: unknown) => toast.error(`Couldn't disconnect Discord: ${e instanceof ApiError ? e.message : String(e)}`),
  });

  // Arriving from a "Connect Discord" door (the going-off offer, the setup
  // card, the account menu, Your account) starts Discord's consent at once:
  // the person already said what they want, and one more Connect button
  // here would be a second ask. Once per visit, and only when there is
  // something to connect.
  const wantsConnect = params.get("connect") === "discord";
  const [autoStarted, setAutoStarted] = useState(false);
  useEffect(() => {
    if (!wantsConnect || autoStarted || discordQ.isLoading || !discordQ.data) return;
    setAutoStarted(true);
    params.delete("connect");
    setParams(params, { replace: true });
    if (discordConnectable(discordQ.data) && !discordQ.data.verified) connect.mutate();
  }, [wantsConnect, autoStarted, discordQ.isLoading, discordQ.data, params, setParams, connect]);

  function clearDiscordParam() {
    if (discordParam) {
      params.delete("discord");
      setParams(params, { replace: true });
    }
  }

  const verified = discordQ.data?.verified ?? false;
  const connected = discordQ.data?.connected ?? false;
  const configured = discordConnectable(discordQ.data);
  // One name for this page wherever it is reached from: the bell's footer, the
  // Notifications tabs, Your account and search (#5565).
  usePageTitle("Notification settings");
  // Connected and previously confirmed, but by the PREVIOUS Discord app. The
  // DM channel belongs to the bot, so the permission does not carry over and
  // messages would go nowhere silently. One re-confirm fixes it.
  const needsReverify = discordQ.data?.needs_reverify ?? false;

  // Offer the "route these to Discord?" prompt once Discord is verified.
  const [promptDismissed, setPromptDismissed] = useState(false);
  useEffect(() => { if (!verified) setPromptDismissed(false); }, [verified]);

  // A link to one row (the feedback email's "switch feedback replies to
  // Discord") lands on it: scrolled to and highlighted.
  const { hash } = useLocation();
  const focusKey = decodeURIComponent(hash.replace(/^#/, ""));
  useEffect(() => {
    if (focusKey && prefsQ.data) document.getElementById(focusKey)?.scrollIntoView({ block: "center" });
  }, [focusKey, prefsQ.data]);

  /** One notification type to Discord only: on for Discord, off for email. */
  async function discordOnly(key: string) {
    await api.setMeCommunicationPref({ notification_type: key, channel: "discord_dm", enabled: true });
    await api.setMeCommunicationPref({ notification_type: key, channel: "email", enabled: false });
    await qc.invalidateQueries({ queryKey: ["comm-prefs"] });
    toast.success("These now come to Discord, not email.");
  }

  async function applyDiscordRouting(mode: "discord_only" | "both") {
    const data = prefsQ.data;
    if (!data) return;
    const tier2 = data.types.filter((t) => t.tier === 2);
    for (const t of tier2) {
      await api.setMeCommunicationPref({ notification_type: t.key, channel: "discord_dm", enabled: true });
      if (mode === "discord_only") {
        await api.setMeCommunicationPref({ notification_type: t.key, channel: "email", enabled: false });
      }
    }
    setPromptDismissed(true);
    qc.invalidateQueries({ queryKey: ["comm-prefs"] });
    toast.success(mode === "discord_only" ? "Tier-2 notifications now go to Discord." : "Tier-2 notifications go to Discord + email.");
  }

  const data = prefsQ.data;
  const columns = data?.channels ?? ["in_app", "discord_dm", "email"];
  // Hide the Discord DM column until verified.
  const visibleColumns = columns.filter((c) => c !== "discord_dm" || verified);

  return (
    <div className="space-y-6">
      <AreaTabs tabs={NOTIFICATION_TABS} area="notifications" />
      <p className="text-sm text-content dark:text-mortar-200">
        Choose how we reach you for each kind of notification. Critical account &
        security messages always go to email. Everything else is yours to route - 
        {configured ? " in-app, Discord DM, email, or any combination." : " in-app, email, or both."}
      </p>

      {/* ── Discord connection card ─────────────────────────────────────── */}
      <DiscordCard
        configured={configured}
        isAdmin={!!user?.is_platform_admin}
        connected={connected}
        verified={verified}
        needsReverify={needsReverify}
        username={discordQ.data?.username ?? null}
        inviteUrl={discordQ.data?.invite_url ?? null}
        discordParam={discordParam}
        connecting={connect.isPending}
        onConnect={() => connect.mutate()}
        onConfirm={() => confirmReceipt.mutate()}
        onRetry={() => retryTest.mutate()}
        onDisconnect={async () => {
          if (await confirm({ title: "Disconnect Discord?", message: "We'll stop sending you Discord DMs. You can reconnect anytime.", confirmLabel: "Disconnect", destructive: true })) {
            disconnect.mutate();
          }
        }}
        loading={discordQ.isLoading}
      />

      {/* ── Push to this phone or computer (#5267) ──────────────────────── */}
      <PushNotificationsCard />

      {/* ── Post-verify routing prompt ──────────────────────────────────── */}
      {verified && !promptDismissed && (
        <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50 p-4 text-sm space-y-3">
          <div className="font-medium text-content dark:text-mortar-100">
            Want your non-critical notifications on Discord?
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => applyDiscordRouting("discord_only")}
              className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-3 py-1.5">
              Discord only
            </button>
            <button type="button" onClick={() => applyDiscordRouting("both")}
              className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:bg-subtle dark:hover:bg-slate-800 text-content dark:text-mortar-200 text-xs font-medium px-3 py-1.5">
              Both Discord + email
            </button>
            <button type="button" onClick={() => setPromptDismissed(true)}
              className="text-xs text-faint hover:text-content px-2 py-1.5">
              Leave as-is
            </button>
          </div>
        </div>
      )}

      {/* ── When things arrive ──────────────────────────────────────────── */}
      {/* Above the matrix on purpose: the matrix answers "does this channel
          hear about it at all", and the first thing people ask after wiring a
          channel up is "how often". */}
      <DeliveryWindows />

      {/* ── Matrix ──────────────────────────────────────────────────────── */}
      {prefsQ.isLoading || !data ? (
        <div className="text-sm text-faint">Loading…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-line dark:border-slate-700 text-xs uppercase tracking-wide text-faint">
                <th className="text-left font-medium py-2 pr-4">Notification</th>
                {visibleColumns.map((c) => (
                  <th key={c} className="font-medium py-2 px-3 text-center whitespace-nowrap">{CHANNEL_LABEL[c] ?? c}</th>
                ))}
                <th className="py-2 px-3" aria-hidden />
              </tr>
            </thead>
            <tbody>
              {data.types.map((t) => (
                <tr
                  key={t.key}
                  id={t.key}
                  className={`border-b border-line/60 dark:border-slate-800 ${t.key === focusKey ? "bg-accent/10 ring-1 ring-inset ring-accent" : ""}`}
                >
                  <td className="py-2.5 pr-4">
                    <div className="font-medium text-content dark:text-mortar-100">{t.label}</div>
                    <div className="text-xs text-faint">{t.description}</div>
                  </td>
                  {t.tier === 1 ? (
                    <td colSpan={visibleColumns.length + 1} className="py-2.5 px-3 text-center">
                      <span className="inline-flex items-center gap-1.5 text-xs text-faint">
                        <Lock size={12} /> Always email
                      </span>
                    </td>
                  ) : (
                    <>
                      {visibleColumns.map((c) => (
                        <td key={c} className="py-2.5 px-3 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-cobble-600 cursor-pointer"
                            checked={data.prefs[t.key]?.[c] ?? false}
                            onChange={(e) =>
                              setPref.mutate({ notification_type: t.key, channel: c, enabled: e.target.checked })
                            }
                            aria-label={`${t.label} via ${CHANNEL_LABEL[c] ?? c}`}
                          />
                        </td>
                      ))}
                      {/* Consolidation nudge: with Discord connected, anything still
                          emailed can move to Discord in one tap (Discord on, email
                          off). An answer then comes by DM and not by email.
                          In-app (the inbox) is left alone. */}
                      <td className="py-2.5 pl-3 align-middle">
                        {verified && (data.prefs[t.key]?.email ?? false) && (
                          <span className="text-xs text-faint whitespace-nowrap">
                            {(data.prefs[t.key]?.discord_dm ?? false) ? "Also emailed. " : "By email. "}
                            <button type="button" onClick={() => void discordOnly(t.key)} className="text-accent hover:underline">
                              Use Discord only?
                            </button>
                          </span>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DiscordCard(props: {
  needsReverify: boolean;
  isAdmin: boolean;
  configured: boolean;
  connected: boolean;
  verified: boolean;
  username: string | null;
  inviteUrl: string | null;
  discordParam: string | null;
  connecting: boolean;
  loading: boolean;
  onConnect: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  onDisconnect: () => void;
}) {
  const { configured, connected, verified, needsReverify, username, inviteUrl, discordParam } = props;

  if (props.loading) return <div className="text-sm text-faint">Checking Discord…</div>;
  if (!configured) {
    // Said once, to the people who can change it. A member can do nothing
    // about it, so for them there is simply no Discord here.
    if (!props.isAdmin) return null;
    return (
      <div className="rounded-lg border border-line dark:border-slate-700 p-4 text-sm space-y-1" data-testid="discord-not-set-up">
        <div className="font-medium text-content dark:text-mortar-100">Discord isn't set up on this server</div>
        <p className="text-muted dark:text-slate-400">
          Nobody here can connect Discord yet, so it is not offered anywhere. To turn it on, give the
          server a Discord application (<code>DISCORD_CLIENT_ID</code>, <code>DISCORD_CLIENT_SECRET</code>,{" "}
          <code>DISCORD_REDIRECT_URI</code>) and a bot to send the messages (<code>COBBLR_DISCORD_BOT_URL</code>),
          then restart it. See "Discord messages" in SELF_HOSTING.md. Until then, notifications reach
          people in the app and by email.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-4 space-y-3">
      {needsReverify && (
        // Says what happened and what it costs. "Reconnect" alone would read as
        // something the person broke, and the honest answer is that Cobblr moved.
        <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          Cobblr moved to a new Discord app. Your account is still linked, but the
          new one has to send you a test DM before it can reach you - until then
          these notifications wait in the bell. Press Reconnect Discord below;
          it takes a few seconds.
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MessageCircle size={18} className="text-[#5865F2]" />
          <span className="font-medium text-content dark:text-mortar-100">Discord</span>
          {verified && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <Check size={13} /> connected{username ? ` as ${username}` : ""}
            </span>
          )}
        </div>
        {verified ? (
          <button type="button" onClick={props.onDisconnect} className="text-xs text-faint hover:text-ember-500">
            Disconnect
          </button>
        ) : (
          <button type="button" onClick={props.onConnect} disabled={props.connecting}
            className="inline-flex items-center gap-2 rounded bg-[#5865F2] hover:brightness-110 text-white text-sm font-medium px-3 py-1.5 disabled:opacity-60">
            <MessageCircle size={15} /> {connected ? "Reconnect Discord" : "Connect Discord"}
          </button>
        )}
      </div>

      {/* Once connected, point them at the community server — it's where the
          live update stream + back-and-forth support (the AI + the team) lives. */}
      {verified && inviteUrl && (
        <div className="text-sm text-content dark:text-mortar-200 rounded-md bg-subtle dark:bg-slate-800/50 p-3 flex items-center justify-between gap-3 flex-wrap">
          <span>You're set for DMs. For live updates + back-and-forth with the team, join the community:</span>
          <a
            href={inviteUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded bg-[#5865F2] hover:brightness-110 text-white text-xs font-medium px-3 py-1.5 shrink-0"
          >
            <MessageCircle size={13} /> Join the community
          </a>
        </div>
      )}

      {/* Verification states after OAuth. */}
      {!verified && connected && (discordParam === "pending" || discordParam === null) && (
        <div className="text-sm text-content dark:text-mortar-200 space-y-2">
          <p>We sent a test DM to your Discord. Tap <strong>“Yes, I got this 👋”</strong> in that message - or confirm here:</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={props.onConfirm}
              className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-3 py-1.5">
              <Check size={13} /> Yes, I received it
            </button>
            <button type="button" onClick={props.onRetry}
              className="rounded border border-line dark:border-slate-600 text-xs font-medium px-3 py-1.5 hover:bg-mortar-50 dark:hover:bg-slate-800">
              Re-send test DM
            </button>
          </div>
        </div>
      )}

      {!verified && (discordParam === "blocked") && (
        <div className="text-sm text-content dark:text-mortar-200 space-y-2">
          <p>We couldn't DM you - Discord blocks DMs from servers you don't share with our bot.</p>
          <div className="flex flex-wrap gap-2">
            {inviteUrl && (
              <a href={inviteUrl} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded bg-[#5865F2] hover:brightness-110 text-white text-xs font-medium px-3 py-1.5">
                Join our Discord server
              </a>
            )}
            <button type="button" onClick={props.onRetry}
              className="rounded border border-line dark:border-slate-600 text-xs font-medium px-3 py-1.5 hover:bg-mortar-50 dark:hover:bg-slate-800">
              I changed my settings - retry
            </button>
          </div>
        </div>
      )}

      {discordParam === "error" && !verified && (
        <div className="text-sm text-ember-600 dark:text-ember-400">
          Something went wrong connecting Discord. Please try again.
        </div>
      )}
    </div>
  );
}
