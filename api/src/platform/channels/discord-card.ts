// A notification's actions, as a Discord card.
//
// Its own module because it is PURE and the channel beside it is not: importing
// discord-dm pulls the meta database and therefore env validation, which exits
// the process when the environment is incomplete. The decisions worth testing
// are all here, and they are testable with nothing running.

import { productName } from "../product-name.js";
import type { NotificationAction } from "../../db/schema.js";

/** Discord's own cap. A longer label is silently rejected for the whole
 *  message, so it is trimmed here rather than losing the notification. */
const LABEL_MAX = 80;

const STYLE: Record<string, number> = { primary: 1, secondary: 2, danger: 4 };

/** The id a press comes back with.
 *
 *  Deliberately just two identifiers: the notification and which of its actions.
 *  Everything else — the org, the action to run, its arguments — is read from
 *  the stored row, because a custom_id arrives from a client and is not
 *  evidence of anything. It also sidesteps Discord's 100-character limit,
 *  which arguments would blow through.  */
export function customIdFor(notificationId: string, actionId: string): string {
  return `cbl:${notificationId}:${actionId}`;
}

export function parseCustomId(raw: string): { notificationId: string; actionId: string } | null {
  const m = /^cbl:([0-9a-f-]{36}):([A-Za-z0-9_-]{1,32})$/.exec(raw);
  return m ? { notificationId: m[1]!, actionId: m[2]! } : null;
}

/** Discord's layout: five buttons per action row, five rows per message. */
const PER_ROW = 5;
const MAX_ROWS = 5;

/** Discord message components for a notification's actions, or undefined.
 *
 *  Laid out five per row, up to five rows, which is Discord's ceiling; a
 *  digest of a dozen items with a pair of answers each fits. Past twenty-five
 *  the rest are dropped and the message still carries its link. */
export function componentsFor(
  notificationId: string,
  actions: NotificationAction[] | null | undefined,
): unknown[] | undefined {
  if (!actions?.length) return undefined;
  const rows: unknown[] = [];
  for (let i = 0; i < actions.length && rows.length < MAX_ROWS; i += PER_ROW) {
    rows.push({
      type: 1, // action row
      components: actions.slice(i, i + PER_ROW).map((a) => ({
        type: 2, // button
        style: STYLE[a.style ?? "secondary"] ?? 2,
        label: a.label.slice(0, LABEL_MAX),
        custom_id: customIdFor(notificationId, a.id),
      })),
    });
  }
  return rows;
}

// ── Components V2: the button beside the line it is about ──────────────────
//
// A classic message cannot interleave buttons with its text: they sit in
// action rows under the embed. A digest of fifteen groceries therefore arrived
// as a list and then fifteen buttons in a block beneath it, each repeating the
// item's name so it could be matched back to its line, and the owner said what
// he wanted in one sentence: the action in line with the item (#3282).
// Discord's Components V2 has that shape: a SECTION is a text display with ONE
// button as its accessory, a CONTAINER gives the colour bar, and the message
// carries the IS_COMPONENTS_V2 flag (with no content and no embeds).
//
// The budget is honest and small: forty components per message, counted WITH
// nesting. A buttoned row is three (section, its text, its button); a second
// answer under the line is an action row, two more; the furniture (container,
// title, footer) is three. So a pair per item fits seven items, one button per
// item fits twelve, and past that the rest are one line, "and N more", with the
// link. The count is computed from the tree, not assumed, and asserted in
// tests: an overflow line that undercounts, or a tree of forty-one, would be a
// message that never arrives.

/** IS_COMPONENTS_V2 (1 << 15). Set on the message; cannot be unset. */
export const COMPONENTS_V2_FLAG = 1 << 15;
/** Discord's ceiling on components per message, nested ones included. */
export const V2_COMPONENT_CAP = 40;
/** Discord's ceiling on text across every text display in the message. */
const V2_TEXT_CAP = 4000;
const ACCENT = 0xc98a3f;

export interface V2CardInput {
  heading?: string;
  context?: string;
  rows: Array<{ text: string; actions?: string[] }>;
}

/** Every component in the tree, nested ones included: Discord's count. */
export function countComponents(components: unknown[]): number {
  let n = 0;
  const walk = (c: unknown) => {
    n += 1;
    const o = c as { components?: unknown[]; accessory?: unknown };
    if (Array.isArray(o.components)) for (const child of o.components) walk(child);
    if (o.accessory) walk(o.accessory);
  };
  for (const c of components) walk(c);
  return n;
}

function textDisplay(content: string): { type: 10; content: string } {
  return { type: 10, content };
}

function button(notificationId: string, a: NotificationAction) {
  return {
    type: 2, // button
    style: STYLE[a.style ?? "secondary"] ?? 2,
    label: (a.short ?? a.label).slice(0, LABEL_MAX),
    custom_id: customIdFor(notificationId, a.id),
  };
}

/** The message as Components V2, or undefined when the card has no rows.
 *
 *  `shownRows` and `hidden` come back with the tree so a caller can say
 *  exactly what was left out. Never over the cap: the layout steps down
 *  (pairs, then one button per row, then fewer rows plus the overflow line)
 *  until the counted tree fits. */
export function componentsV2For(
  notificationId: string,
  card: V2CardInput,
  actions: NotificationAction[] | null | undefined,
  linkUrl?: string | null,
  /** Where "and N more" lands. It must show EVERY row, hidden ones included,
   *  or the line undercounts what it points at; the notification's own page
   *  in the app renders all of them with their buttons, so that is the
   *  default over the card's link (a calendar month can cut a set in two). */
  overflowUrl?: string | null,
): { components: unknown[]; shown: number; hidden: number } | undefined {
  if (!card.rows.length) return undefined;
  const byId = new Map((actions ?? []).map((a) => [a.id, a]));
  const rows = card.rows.map((r) => ({
    text: r.text,
    actions: (r.actions ?? []).map((id) => byId.get(id)).filter((a): a is NotificationAction => !!a),
  }));

  const build = (shown: number, perRow: number): unknown[] => {
    const inner: unknown[] = [];
    if (card.heading) {
      const title = linkUrl ? `### [${card.heading}](${linkUrl})` : `### ${card.heading}`;
      inner.push(textDisplay(title));
    }
    for (const r of rows.slice(0, shown)) {
      const [first, second] = r.actions;
      if (first && perRow >= 1) {
        inner.push({ type: 9, components: [textDisplay(r.text)], accessory: button(notificationId, first) });
      } else {
        inner.push(textDisplay(r.text));
      }
      if (second && perRow >= 2) {
        inner.push({ type: 1, components: [button(notificationId, second)] });
      }
    }
    const hidden = rows.length - shown;
    if (hidden > 0) {
      const more = `and ${hidden} more`;
      const to = overflowUrl ?? linkUrl;
      inner.push(textDisplay(to ? `[${more}, in ${productName()}](${to})` : more));
    }
    if (card.context) inner.push(textDisplay(`-# ${card.context.slice(0, 200)}`));
    return [{ type: 17, accent_color: ACCENT, components: inner }];
  };

  const fits = (tree: unknown[]): boolean => {
    if (countComponents(tree) > V2_COMPONENT_CAP) return false;
    let text = 0;
    const walk = (c: unknown) => {
      const o = c as { type?: number; content?: string; components?: unknown[] };
      if (o.type === 10 && typeof o.content === "string") text += o.content.length;
      if (Array.isArray(o.components)) for (const child of o.components) walk(child);
    };
    for (const c of tree) walk(c);
    return text <= V2_TEXT_CAP;
  };

  // Pairs for everyone, then one button each, then fewer rows: the first
  // layout that fits is the message.
  for (const perRow of [2, 1]) {
    const tree = build(rows.length, perRow);
    if (fits(tree)) return { components: tree, shown: rows.length, hidden: 0 };
  }
  for (let shown = rows.length - 1; shown >= 0; shown--) {
    const tree = build(shown, 1);
    if (fits(tree)) return { components: tree, shown, hidden: rows.length - shown };
  }
  return undefined;
}

// ── The push line ─────────────────────────────────────────────────────────
//
// A Components V2 message cannot carry `content`, so a card-only DM arrived on
// the owner's phone as a notification with no text at all: the push preview is
// built from the message, and the message was all card (2026-09-26). Every DM
// therefore carries ONE plain line saying what it is ("1 thing to use up:
// Boneless Skinless Chicken, expires in 1d"), and the bot decides where it goes
// so the push has words. Required on sendDiscordDm, and never empty: a caller
// with nothing to say still gets the floor below rather than a blank push.

/** Discord's push preview truncates long before this; one line reads best. */
const SUMMARY_MAX = 150;
const SUMMARY_FLOOR = `You have a new notification in ${productName()}`;

/** The first non-empty candidate as ONE plain line: markdown headings, link
 *  syntax and bold marks stripped, whitespace collapsed, capped with an
 *  ellipsis. Never empty. */
export function dmSummary(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const line = (c ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!line) continue;
    const plain = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^-#\s+/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|_|`)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!plain) continue;
    return plain.length > SUMMARY_MAX ? `${plain.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : plain;
  }
  return SUMMARY_FLOOR;
}
