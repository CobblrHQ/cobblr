// "This one." A record, handed to Cobb.
//
// Ticking a checkbox already says which rows you mean, so on a LIST this is a
// second way to do what the checkbox does — and a second way is noise. Where it
// earns its keep is a record with no checkbox anywhere near it: a detail
// header, a card, the thing you are looking AT.
//
// Always visible, never on hover. Cobblr rows carry their actions in the open
// (add, edit, delete, all the time), and the app gates every hover style behind
// `hoverOnlyWhenSupported` because iOS turns the first tap into a hover — so a
// control that appears on hover is one a phone in a workshop cannot reach. It
// sits at the size of its neighbours and lights AMBER when this is the record in
// context: the same amber as the highlight on the page, so the two read as one
// idea rather than two.

import { MessageSquare } from "lucide-react";
import { usePlatformWeb } from "./context";
import { publishRowSelection, useChatSelection } from "./chat-context";

export function AskCobbAbout({
  kind,
  id,
  label,
  className,
}: {
  /** Entity kind id — what makes this something Cobb can act on rather than
   *  a name he has to go and find again. */
  kind: string;
  id: string;
  /** What a person calls it, for the chip. */
  label: string;
  className?: string;
}) {
  const { cobbIcon: Cobb } = usePlatformWeb();
  const selection = useChatSelection();
  const inContext = (selection?.ids ?? []).includes(id);

  return (
    <button
      type="button"
      aria-pressed={inContext}
      title={inContext ? `Cobb is talking about ${label}. Click to stop.` : `Ask Cobb about ${label}`}
      aria-label={inContext ? `Stop talking about ${label}` : `Ask Cobb about ${label}`}
      onClick={() => {
        if (inContext) {
          publishRowSelection(null);
          return;
        }
        publishRowSelection({ label, kind, ids: [id], text: label });
        // Opening it is the point: you pressed this because you have something
        // to ask. Whatever conversation was already there is kept.
        window.dispatchEvent(
          new CustomEvent("cobblr:open-chat", { detail: { seed: `Ask about ${label}…` } }),
        );
      }}
      className={
        "inline-flex items-center justify-center rounded-md w-7 h-7 transition border " +
        (inContext
          ? "bg-amber-400 border-amber-400 text-cobble-900 "
          : "border-transparent text-faint dark:text-slate-500 hover:text-accent hover:border-line dark:hover:border-slate-600 ") +
        (className ?? "")
      }
    >
      {/* A host that has not handed over the artwork still gets a working
          button — the mechanism does not depend on the drawing. */}
      {Cobb ? <Cobb size={16} title="" /> : <MessageSquare size={15} />}
    </button>
  );
}
