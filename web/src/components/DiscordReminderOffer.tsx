// "Get a Discord message before things go off", offered where it matters.
//
// The DM feature existed and nobody found it: it lived as a card on the
// Delivery tab of Notifications under Your account, three levels from where
// anybody thinks about reminders (the owner, 2026-09-29: "even I have to dig
// too much to find it"). So it is offered at the moment it is useful, the
// first time the workspace has things with a date on them, once, and gone
// for good when connected or dismissed.
//
// One tap: the button goes to Discord's own consent screen, and the way back
// lands on the Delivery page with the test message already sent and the
// morning digest already chosen (me.ts oauth-start). Every door into it
// (this offer, the setup card, Your account, the account menu, search) uses
// the same link, CONNECT_DISCORD_PATH (lib/discord-connect.ts).
import { useState } from "react";
import { Link } from "react-router-dom";
import { MessageCircle, X } from "lucide-react";
import { CONNECT_DISCORD_PATH, discordConnectable } from "../lib/discord-connect";
import { useDiscordStatus } from "../lib/useDiscordStatus";

const DISMISSED_KEY = "cobblr.offer.discord-reminders.dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Not remembered on this device: it comes back next visit, which is
    // the harmless way for this to fail.
  }
}

/** Whether to offer: the server can DM, this person has not proved a DM
 *  reaches them yet, they have not said no, and there is something dated
 *  for a reminder to be about. */
export function discordOfferWanted(o: {
  hasDated: boolean;
  status: { configured?: boolean; verified?: boolean } | undefined;
  dismissed: boolean;
}): boolean {
  return o.hasDated && discordConnectable(o.status) && !o.status?.verified && !o.dismissed;
}

export function DiscordReminderOffer({ hasDated }: { hasDated: boolean }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const status = useDiscordStatus(hasDated && !dismissed);
  if (!discordOfferWanted({ hasDated, status: status.data, dismissed })) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-[#5865F2]/30 bg-[#5865F2]/5 dark:bg-[#5865F2]/10 px-3 py-2"
      data-testid="discord-reminder-offer"
    >
      <MessageCircle size={16} className="shrink-0 text-[#5865F2]" />
      <span className="min-w-0 flex-1 text-sm text-content dark:text-mortar-100">Get a Discord message before things go off</span>
      <Link
        to={CONNECT_DISCORD_PATH}
        className="inline-flex items-center gap-1.5 rounded bg-[#5865F2] hover:brightness-110 text-white text-xs font-medium px-3 py-1.5"
      >
        Connect Discord
      </Link>
      <button
        type="button"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
        className="p-1 text-faint hover:text-content"
        aria-label="Not now"
        title="Not now"
      >
        <X size={14} />
      </button>
    </div>
  );
}
