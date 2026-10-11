// The open bell offers notifications on this device (#5565). Web Push replaced
// the old in-page browser notifications and its setup lived only on the
// account's Communication page, so a person who had them could no longer find
// them. Here, at the top of the bell: one row saying what this device can do
// and the one tap that does it. The offer can be put away and stays away on
// this device; once it is on, the row says so and offers Send a test and Turn
// off. Settings is in every state (#5774: it used to vanish at Turn on). A
// Turn on that did not finish says what failed and what to do, with Try again
// (#5810: a refused registration used to bring back the same button, silent).
import { useState } from "react";
import { AlertTriangle, BellRing, Smartphone, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Modal, StatusRow } from "@cobblr/platform-web";
import { dismissInstall } from "../lib/install-app";
import { usePushHere } from "../lib/usePushHere";
import { InstallWalkBody } from "./InstallWalk";

export const BELL_PUSH_DISMISSED_KEY = "cobblr.push.bell-offer-dismissed";
export const NOTIFICATION_SETTINGS_PATH = "/me/communication";

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(BELL_PUSH_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

const row = "mx-2 mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 px-3 py-2 text-xs text-content dark:text-mortar-200";
const act = "rounded-md bg-cobble-600 hover:bg-cobble-700 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60";
const quietAct = "rounded-md border border-line dark:border-slate-600 px-2.5 py-1 text-xs text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-60";

export function BellPushRow({ onNavigate }: { onNavigate: () => void }) {
  const { q, route, readiness, here, publicKey, turnOn, failure, remove, test } = usePushHere();
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [walking, setWalking] = useState(false);
  if (q.isLoading || !q.data) return null;
  // Off, an offer that was put away or that this device cannot take says nothing.
  if (!here && !failure && (dismissed || !publicKey || readiness.kind === "unsupported")) return null;
  const state: "on" | "install-first" | "denied" | "failed" | "offer" = here ? "on" : readiness.kind === "install-first" ? "install-first" : readiness.kind === "denied" ? "denied" : failure ? "failed" : "offer";

  const dismiss = (
    <button
      type="button"
      title="Not now"
      aria-label="Hide this offer on this device"
      className="ml-auto text-faint hover:text-content dark:text-slate-500 dark:hover:text-mortar-200"
      onClick={() => {
        try {
          localStorage.setItem(BELL_PUSH_DISMISSED_KEY, "1");
        } catch {
          /* it comes back next time; nothing else is lost */
        }
        setDismissed(true);
      }}
    >
      <X size={14} />
    </button>
  );

  return (
    <StatusRow
      state={state}
      className={row}
      testId={`bell-push-${state}`}
      states={{
        on: (
          <>
            <BellRing size={14} className="text-accent shrink-0" aria-hidden />
            <span className="flex-1 min-w-0">Notifications on this device</span>
            <button type="button" className={quietAct} disabled={test.isPending || !here} onClick={() => here && test.mutate(here.id)} data-testid="bell-push-test">
              {test.isPending ? "Sending…" : "Send a test"}
            </button>
            <button type="button" className={quietAct} disabled={remove.isPending || !here} onClick={() => here && remove.mutate(here.id)}>
              {remove.isPending ? "Turning off…" : "Turn off"}
            </button>
          </>
        ),
        "install-first": (
          <>
            <Smartphone size={14} className="text-accent shrink-0" aria-hidden />
            <span className="flex-1 min-w-0">Get notifications on this device: add Cobblr to your Home Screen first, then open it from there.</span>
            <button type="button" className={quietAct} onClick={() => setWalking(true)}>
              Show me how
            </button>
            {walking && (
              <Modal open onClose={() => setWalking(false)} size="sm">
                <InstallWalkBody route={route} onDone={() => setWalking(false)} onNotNow={() => { dismissInstall(); setWalking(false); }} />
              </Modal>
            )}
          </>
        ),
        denied: (
          <>
            <BellRing size={14} className="text-faint shrink-0" aria-hidden />
            <span className="flex-1 min-w-0">This device blocks notifications from Cobblr. {readiness.kind === "denied" ? readiness.howToAllow : null}</span>
          </>
        ),
        failed: (
          <>
            <AlertTriangle size={14} className="text-ember-600 dark:text-ember-300 shrink-0 self-start mt-0.5" aria-hidden />
            <span className="flex-1 min-w-[12rem]" role="alert" data-testid="bell-push-problem">
              {failure?.says} {failure?.next}
            </span>
            <button type="button" className={act} disabled={turnOn.isPending} onClick={() => turnOn.mutate()} data-testid="bell-push-retry">
              {turnOn.isPending ? "Trying…" : "Try again"}
            </button>
          </>
        ),
        offer: (
          <>
            <BellRing size={14} className="text-accent shrink-0" aria-hidden />
            <span className="flex-1 min-w-0">Get notifications on this device</span>
            <button type="button" className={act} disabled={turnOn.isPending} onClick={() => turnOn.mutate()} data-testid="bell-push-turn-on">
              {turnOn.isPending ? "Turning on…" : "Turn on"}
            </button>
          </>
        ),
      }}
      // What a person may want whatever the state: where these are set.
      always={
        <Link to={NOTIFICATION_SETTINGS_PATH} onClick={onNavigate} className="text-accent hover:underline" data-testid="bell-push-settings">
          Settings
        </Link>
      }
      end={state === "on" ? null : dismiss}
    />
  );
}
