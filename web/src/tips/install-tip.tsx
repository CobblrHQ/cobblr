// The first tip: put Cobblr on this phone's home screen.
//
// Offered to a phone browser that is not the installed app. The install walk
// used to appear only in the guided tour and once after a first scan, so a
// person who skipped the tour and never scanned (someone who starts by
// uploading) never saw it (#4333). As a tip it reaches everyone on a phone
// browser, one tip at a time, and "Not now" is remembered on THIS phone,
// because being installed is a fact about the phone, not the person.
//
// The standing door is `InstallThisPhoneItem` in the account menu: it ignores
// "Not now", so a person who declined can still find it.
import { useState } from "react";
import { Smartphone } from "lucide-react";
import { Modal, registerTip, type Tip } from "@cobblr/platform-web";
import { InstallWalkBody } from "../components/InstallWalk";
import { dismissInstall, installDismissed, installRoute, readInstallEnv, shouldOfferInstall, type InstallRoute } from "../lib/install-app";

export const INSTALL_TIP_ID = "install-app";

export const installTip: Tip = {
  id: INSTALL_TIP_ID,
  priority: 100,
  applies: () => shouldOfferInstall(installRoute(readInstallEnv())),
  text: "Cobblr works best as an app on this phone.",
  actionLabel: "Show me",
  body: ({ close, dismiss }) => <InstallWalkBody route={installRoute(readInstallEnv())} onDone={close} onNotNow={dismiss} />,
  device: { dismissed: installDismissed, dismiss: dismissInstall },
};

registerTip(installTip);

/** Whether this browser can be installed at all: a phone browser, not the app. */
export function canInstallHere(route: InstallRoute = installRoute(readInstallEnv())): boolean {
  return route.kind !== "installed" && route.kind !== "desktop";
}

/** "Install Cobblr on this phone" for the account menu. Always there on a
 *  phone browser, whatever "Not now" said. */
export function InstallThisPhoneItem({ className, onOpen }: { className: string; onOpen?: () => void }) {
  const [route] = useState(() => installRoute(readInstallEnv()));
  const [walking, setWalking] = useState(false);
  if (!canInstallHere(route)) return null;
  return (
    <>
      <button type="button" className={className} role="menuitem" onClick={() => { onOpen?.(); setWalking(true); }}>
        <Smartphone size={14} className="text-faint dark:text-slate-400" /> Install Cobblr on this phone
      </button>
      {walking && (
        <Modal open onClose={() => setWalking(false)} size="sm">
          <InstallWalkBody route={route} onDone={() => setWalking(false)} onNotNow={() => { dismissInstall(); setWalking(false); }} />
        </Modal>
      )}
    </>
  );
}
