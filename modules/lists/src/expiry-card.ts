// The expiry digest as a CARD with the answers on it.
//
// "2 things to use up: Baby Carrots, Cucumbers, <link>" arrived as three lines
// of plain text and a URL (2026-09-07). The link is the least useful thing on
// it: the person reading it is standing at the fridge, and what they want to
// say is "ate them" or "binned them", not "open the calendar". Both of those
// are actions the inventory module already registers (use-up, mark-spoiled),
// idempotent and undoable, so the card offers them as buttons, one pair per
// item, and a press runs the real thing through the same door every other
// notification button uses.
//
// Pure: takes the rows, returns what dispatch needs. Tested without a network.
//
// The card carries its lines as ROWS, each naming its own pair of answers, so
// a channel that can put a button beside the line it is about does (a Discord
// DM lays each row out as a section with "Used up" as its accessory and
// "Threw out" under it; the in-app card renders each row with its buttons).
// The list-then-a-block-of-fifteen-buttons shape, each button repeating the
// name so it could be matched back to its line, is what the owner asked to
// lose (#3282). A channel that cannot pair them still has the body and the
// flat actions, whose labels carry the name for exactly that reason.

import type { NotificationAction, NotificationCardRow } from "@cobblr/platform-contract";

export interface ExpiryLine {
  id: string;
  name: string;
  /** "expires in 5d", "expired 2d ago", "use today" - already phrased. */
  tone: string;
}

/** Discord renders at most 25 buttons on a message (five rows of five). A
 *  pair per item fits twelve items; past that only "Used up" is offered, and
 *  past twenty-five the rest have the card and the link. */
export const BUTTON_CAP = 25;
const PAIR_LIMIT = Math.floor(BUTTON_CAP / 2);
/** A button label is capped at 80 by Discord; the verb needs room too. */
const NAME_IN_LABEL = 40;

export interface ExpiryDigest {
  message: string;
  card: { heading: string; body: string; context?: string; rows: NotificationCardRow[] };
  actions: NotificationAction[];
}

function shortName(name: string): string {
  const n = name.trim();
  return n.length > NAME_IN_LABEL ? `${n.slice(0, NAME_IN_LABEL - 1)}…` : n;
}

export function expiryDigest(lines: readonly ExpiryLine[], opts: { workspace?: string | null } = {}): ExpiryDigest {
  const heading = lines.length === 1 ? "1 thing to use up" : `${lines.length} things to use up`;
  const body = lines.map((l) => `• **${l.name}** — ${l.tone}`).join("\n");
  const message = lines.length === 1 ? `${lines[0]!.name} — ${lines[0]!.tone}` : `${heading}:\n${lines.map((l) => `${l.name} — ${l.tone}`).join("\n")}`;

  const actions: NotificationAction[] = [];
  const rows: NotificationCardRow[] = [];
  const pairs = lines.length <= PAIR_LIMIT;
  for (const l of lines) {
    const row: NotificationCardRow = { text: `**${l.name}** — ${l.tone}`, actions: [] };
    rows.push(row);
    if (actions.length >= BUTTON_CAP) continue;
    const used: NotificationAction = {
      id: `used-${actions.length}`,
      label: `Used up · ${shortName(l.name)}`,
      short: "Used up",
      action: "inventory:use-up",
      args: { partId: l.id },
      style: "primary",
    };
    actions.push(used);
    row.actions!.push(used.id);
    if (pairs && actions.length < BUTTON_CAP) {
      const tossed: NotificationAction = {
        id: `tossed-${actions.length}`,
        label: `Threw out · ${shortName(l.name)}`,
        short: "Threw out",
        action: "inventory:mark-spoiled",
        args: { partId: l.id },
        style: "danger",
      };
      actions.push(tossed);
      row.actions!.push(tossed.id);
    }
  }

  return {
    message,
    card: {
      heading,
      body,
      rows,
      ...(opts.workspace ? { context: opts.workspace } : {}),
    },
    actions,
  };
}
