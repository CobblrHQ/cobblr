// Several orders to ask about on one morning are ONE card with a line and an
// answer each, and an "All arrived" for the common case. Pure: takes the
// questions, returns what dispatch needs.
import { countOf, type NotificationAction, type NotificationCardRow } from "@cobblr/platform-contract";

export interface ArrivalAsk {
  orderId: string;
  /** What a person calls the order: the store, else its number. */
  name: string;
  orderNumber: string | null;
  /** The question as the one-order message words it. */
  question: string;
}

/** Discord renders at most 25 buttons on a message; the last is "All arrived". */
const BUTTON_CAP = 25;
const NAME_IN_LABEL = 40;

function shortName(name: string): string {
  const n = name.trim();
  return n.length > NAME_IN_LABEL ? `${n.slice(0, NAME_IN_LABEL - 1)}…` : n;
}

/** The line that says one order's question: what its row reads, and what the
 *  notifier keeps when an overlapping notice says only what is new. */
export function arrivalLine(a: ArrivalAsk): string {
  return a.orderNumber && !a.question.includes(a.orderNumber) ? `${a.question} (#${a.orderNumber})` : a.question;
}

export function arrivalDigest(asks: readonly ArrivalAsk[]): {
  message: string;
  card: { heading: string; body: string; rows: NotificationCardRow[] };
  actions: NotificationAction[];
} {
  const heading = `${countOf(asks.length, "order")} to check`;
  const lineOf = arrivalLine;
  const actions: NotificationAction[] = [];
  const rows: NotificationCardRow[] = asks.map((a, i) => {
    const row: NotificationCardRow = { text: lineOf(a), actions: [] };
    if (i < BUTTON_CAP - 1) {
      const yes: NotificationAction = {
        id: `arrived-${i}`,
        label: `Yes, it turned up · ${shortName(a.name)}`,
        short: "Yes, it turned up",
        action: "purchases:mark-arrived",
        args: { orderId: a.orderId },
        style: "primary",
      };
      actions.push(yes);
      row.actions!.push(yes.id);
    }
    return row;
  });
  actions.push({
    id: "arrived-all",
    label: "All arrived",
    action: "purchases:mark-arrived",
    args: { orderIds: asks.map((a) => a.orderId) },
    style: "primary",
  });
  return {
    message: `${heading}:\n${asks.map(lineOf).join("\n")}`,
    card: { heading, body: asks.map((a) => `• ${lineOf(a)}`).join("\n"), rows },
    actions,
  };
}
