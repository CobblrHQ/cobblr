// Notifications on this phone or computer (#5267): Web Push, the iPhone and
// iPad Home Screen app included. One card on the account's Notifications
// page: turn it on for this device (a tap, so iOS lets the browser ask), the
// devices that get pushes and how each last fared, what is worth a push, and
// quiet hours.
import { productName } from "@cobblr/platform-web";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { BellRing, Moon, Smartphone } from "lucide-react";
import { Modal, relativeTime, useConfirm, useToast } from "@cobblr/platform-web";
import { api, type MePushSettings, type NotificationPriority } from "../lib/api";
import { dismissInstall } from "../lib/install-app";
import { usePushHere } from "../lib/usePushHere";
import { InstallWalkBody } from "./InstallWalk";

const THRESHOLDS: Array<{ value: NotificationPriority; label: string }> = [
  { value: "urgent", label: "Urgent only" },
  { value: "high", label: "High and urgent" },
  { value: "normal", label: "Normal and above" },
  { value: "low", label: "Everything" },
];

const asTime = (m: number | null) => (m == null ? "" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const fromTime = (v: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
};

const button = "inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-3 py-1.5 disabled:opacity-60";
const quiet = "inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:bg-subtle dark:hover:bg-slate-800 text-content dark:text-mortar-200 text-xs font-medium px-3 py-1.5 disabled:opacity-60";

export function PushNotificationsCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [walking, setWalking] = useState(false);
  const { q, route, readiness, devices, here, mine, turnOn, failure, remove, test, refresh } = usePushHere();
  const save = useMutation({
    mutationFn: (body: Partial<MePushSettings>) => api.setMePushSettings(body),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save"),
  });

  const settings = q.data?.settings;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const quietOn = settings?.quiet_start_minute != null && settings.quiet_end_minute != null;

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-4 space-y-4" data-testid="push-card">
      <div className="flex items-start gap-3">
        <BellRing size={18} className="mt-0.5 text-accent shrink-0" aria-hidden />
        <div className="space-y-1">
          <div className="font-medium text-content dark:text-mortar-100">Notifications on your phone and computer</div>
          <p className="text-sm text-muted dark:text-slate-400">
            {productName()} can buzz this device for what needs you, even when the app is closed. Each phone and computer is turned on by itself.
          </p>
        </div>
      </div>

      {/* This device. */}
      {q.isLoading ? (
        <div className="text-sm text-faint">Checking…</div>
      ) : readiness.kind === "install-first" ? (
        <div className="rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50 p-3 text-sm space-y-2" data-testid="push-install-first">
          <p className="text-content dark:text-mortar-200">
            Add {productName()} to your Home Screen first (Share, then Add to Home Screen), then open it from there and turn notifications on here.
          </p>
          <p className="text-xs text-muted dark:text-slate-400">An iPhone or iPad only lets an app on the Home Screen send notifications.</p>
          <button type="button" className={quiet} onClick={() => setWalking(true)}>
            <Smartphone size={14} aria-hidden /> Show me how
          </button>
        </div>
      ) : readiness.kind === "unsupported" ? (
        <p className="text-sm text-muted dark:text-slate-400" data-testid="push-unsupported">
          This browser can't show notifications from {productName()}. Open {productName()} in Chrome, Edge, Firefox or Safari, or from the Home Screen on an iPhone or iPad.
        </p>
      ) : readiness.kind === "denied" ? (
        <div className="text-sm space-y-1" data-testid="push-denied">
          <p className="text-content dark:text-mortar-200">This device said no to notifications from {productName()}, so only its own settings can let them in again.</p>
          <p className="text-muted dark:text-slate-400">{readiness.howToAllow}</p>
        </div>
      ) : here ? (
        <p className="text-sm text-content dark:text-mortar-200" data-testid="push-on-here">Notifications are on for this device.</p>
      ) : failure ? (
        // A Turn on that did not finish says what failed and what to do,
        // until the next try (#5810).
        <div className="rounded-md border border-ember-200 dark:border-ember-700 bg-ember-50 dark:bg-ember-900/30 p-3 text-sm space-y-2" role="alert" data-testid="push-problem">
          <p className="text-content dark:text-mortar-100">{failure.says}</p>
          <p className="text-muted dark:text-slate-400">{failure.next}</p>
          <button type="button" className={button} disabled={turnOn.isPending} onClick={() => turnOn.mutate()} data-testid="push-retry">
            {turnOn.isPending ? "Trying…" : "Try again"}
          </button>
        </div>
      ) : q.isError ? (
        <p className="text-sm text-muted dark:text-slate-400" role="alert" data-testid="push-unchecked">
          Couldn't check notifications for this device{q.error instanceof Error ? `: ${q.error.message.replace(/[.!?]$/, "")}` : ""}. Reload the page to try again.
        </p>
      ) : !q.data?.public_key ? (
        <p className="text-sm text-muted dark:text-slate-400" data-testid="push-unavailable">{q.data?.unavailable ?? "This server is still making its push key. Reload in a minute."}</p>
      ) : (
        <button type="button" className={button} disabled={turnOn.isPending} onClick={() => turnOn.mutate()} data-testid="push-turn-on">
          {turnOn.isPending ? "Turning on…" : "Turn on notifications on this device"}
        </button>
      )}

      {/* Every device that gets pushes. */}
      {devices.length > 0 && (
        <ul className="divide-y divide-line dark:divide-slate-700 rounded-md border border-line dark:border-slate-700" data-testid="push-devices">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="text-content dark:text-mortar-100 break-words">
                  {d.label}
                  {d.id === mine && <span className="ml-2 text-xs text-faint">this device</span>}
                </div>
                <div className="text-xs text-muted dark:text-slate-400">
                  {d.last_failure && (!d.last_success_at || (d.last_failure_at && d.last_failure_at > d.last_success_at))
                    ? `Last try failed: ${d.last_failure}`
                    : d.last_success_at
                      ? `Last delivered ${relativeTime(d.last_success_at)}`
                      : "Nothing sent yet"}
                </div>
              </div>
              <button type="button" className={quiet} disabled={test.isPending} onClick={() => test.mutate(d.id)}>
                Send a test
              </button>
              <button
                type="button"
                className={quiet}
                disabled={remove.isPending}
                onClick={async () => {
                  if (await confirm({ title: `Stop notifications on ${d.label}?`, message: `It stops buzzing for ${productName()}. Turn it on there again whenever you like.`, confirmLabel: "Remove", destructive: true })) remove.mutate(d.id);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* What is worth a push, and when not to. */}
      {settings && devices.length > 0 && (
        <div className="space-y-3 text-sm">
          <label className="flex flex-wrap items-center gap-2">
            <span className="text-content dark:text-mortar-200">Push me for</span>
            <select
              className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-sm"
              value={settings.min_priority}
              onChange={(e) => save.mutate({ min_priority: e.target.value as NotificationPriority })}
            >
              {THRESHOLDS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <span className="text-xs text-muted dark:text-slate-400">Everything else stays in the bell.</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={quietOn}
                onChange={(e) =>
                  save.mutate(e.target.checked ? { quiet_start_minute: 22 * 60, quiet_end_minute: 7 * 60, timezone: zone } : { quiet_start_minute: null, quiet_end_minute: null })
                }
              />
              <Moon size={14} aria-hidden /> Quiet hours
            </label>
            {quietOn && (
              <>
                <input type="time" aria-label="Quiet from" className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1" value={asTime(settings.quiet_start_minute)} onChange={(e) => save.mutate({ quiet_start_minute: fromTime(e.target.value), timezone: zone })} />
                <span>to</span>
                <input type="time" aria-label="Quiet until" className="rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1" value={asTime(settings.quiet_end_minute)} onChange={(e) => save.mutate({ quiet_end_minute: fromTime(e.target.value), timezone: zone })} />
              </>
            )}
          </div>
          {quietOn && (
            <p className="text-xs text-muted dark:text-slate-400">
              Nothing but urgent pushes then; what waits arrives as one push when quiet hours end.
              {q.data?.quiet_now && q.data.held > 0 ? ` ${q.data.held} waiting now.` : ""}
            </p>
          )}
        </div>
      )}

      {walking && (
        <Modal open onClose={() => setWalking(false)} size="sm">
          <InstallWalkBody route={route} onDone={() => setWalking(false)} onNotNow={() => { dismissInstall(); setWalking(false); }} />
        </Modal>
      )}
    </div>
  );
}
