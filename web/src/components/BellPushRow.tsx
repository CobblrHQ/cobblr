// The open bell offers notifications on this device (#5565). Web Push replaced
// the old in-page browser notifications and its setup lived only on the
// account's Communication page, so a person who had them could no longer find
// them. Here, at the top of the bell: one row saying what this device can do
// and the one tap that does it. The offer can be put away and stays away on
// this device; once it is on, the row says so and offers Turn off.
import { useState } from "react";
import { BellRing, Smartphone, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Modal } from "@cobblr/platform-web";
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
  const { q, route, readiness, here, publicKey, turnOn, remove } = usePushHere();
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [walking, setWalking] = useState(false);
  if (q.isLoading || !q.data) return null;

  if (here) {
    return (
      <div className={row} data-testid="bell-push-on">
        <BellRing size={14} className="text-accent shrink-0" aria-hidden />
        <span className="flex-1 min-w-0">Notifications on this device</span>
        <button type="button" className={quietAct} disabled={remove.isPending} onClick={() => remove.mutate(here.id)}>
          {remove.isPending ? "Turning off…" : "Turn off"}
        </button>
      </div>
    );
  }
  // A server with no key yet, or a browser with no push at all, has nothing to offer here.
  if (dismissed || !publicKey || readiness.kind === "unsupported") return null;
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

  if (readiness.kind === "install-first") {
    return (
      <div className={row} data-testid="bell-push-install-first">
        <Smartphone size={14} className="text-accent shrink-0" aria-hidden />
        <span className="flex-1 min-w-0">Get notifications on this device: add Cobblr to your Home Screen first, then open it from there.</span>
        <button type="button" className={quietAct} onClick={() => setWalking(true)}>
          Show me how
        </button>
        {dismiss}
        {walking && (
          <Modal open onClose={() => setWalking(false)} size="sm">
            <InstallWalkBody route={route} onDone={() => setWalking(false)} onNotNow={() => { dismissInstall(); setWalking(false); }} />
          </Modal>
        )}
      </div>
    );
  }
  if (readiness.kind === "denied") {
    return (
      <div className={row} data-testid="bell-push-denied">
        <BellRing size={14} className="text-faint shrink-0" aria-hidden />
        <span className="flex-1 min-w-0">This device blocks notifications from Cobblr. {readiness.howToAllow}</span>
        {dismiss}
      </div>
    );
  }
  return (
    <div className={row} data-testid="bell-push-offer">
      <BellRing size={14} className="text-accent shrink-0" aria-hidden />
      <span className="flex-1 min-w-0">Get notifications on this device</span>
      <button type="button" className={act} disabled={turnOn.isPending} onClick={() => turnOn.mutate()} data-testid="bell-push-turn-on">
        {turnOn.isPending ? "Turning on…" : "Turn on"}
      </button>
      <Link to={NOTIFICATION_SETTINGS_PATH} onClick={onNavigate} className="text-accent hover:underline">
        Settings
      </Link>
      {dismiss}
    </div>
  );
}
