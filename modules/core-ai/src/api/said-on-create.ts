// What the person said is on the card, and nothing they did not say is.
//
//   "Add my DeWalt cordless drill, model DCD771, on the Workbench. It's a tool
//    I own, I paid $99 for it."
//     -> create_record assets:asset { name, model, purchased_at: "2025-01-01" }
//
// The card carried no place and no price, both said, and a purchase date
// nobody said, shown as a fact (#9515, round 6 walk). A date filled in with
// no date in the message is the model's guess, so it is left off the card in
// place. A price or a place said and missing from a kind that keeps one is
// handed back once, naming the field, the way a missing required field is
// (required-on-create.ts).
import { MONEY_ROLES } from "@cobblr/platform-contract/money";
import type { KindRec } from "@cobblr/workspace-tools";
import type { ToolCall } from "../providers/tool-wire.js";

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAYS = "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";
/** Any way a person says when: a year, a numeric date, a month or weekday,
 *  or a word relative to today. */
const SAID_A_DATE = new RegExp(
  `\\b(?:(?:19|20)\\d\\d|\\d{1,2}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?|${MONTHS}|${DAYS}|today|yesterday|tomorrow|tonight|ago|last|this (?:week|month|year)|next|since|christmas|birthday)\\b`,
  "i",
);
/** A price: a currency sign or word with a number, or "paid"/"cost" with one. */
const SAID_A_PRICE = /(?:[$€£¥]\s?\d|\d\s?(?:dollars?|euros?|pounds?|usd|eur|gbp)\b|\b(?:paid|cost|costs|bought (?:it )?for|price)\b[^.?!]{0,20}\d)/i;
/** A place: "on the Workbench", "in Shelf A", "at my Garage" (a name, capitalised). */
const SAID_A_PLACE = /\b(?:on|in|at|into|onto|inside)\s+(?:the\s+|my\s+)?([A-Z][\w'-]*(?:\s+[A-Z0-9][\w'-]*){0,3})/;

type Field = NonNullable<KindRec["fields"]>[number];

function writing(call: ToolCall, kinds: readonly KindRec[]): { kind: KindRec; fields: Record<string, unknown> } | null {
  if (call.name !== "create_record") return null;
  const args = (call.args ?? {}) as Record<string, unknown>;
  const kind = kinds.find((k) => k.id === String(args.kind ?? ""));
  const fields = args.fields;
  if (!kind || !fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  return { kind, fields: fields as Record<string, unknown> };
}

const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && !v.trim());

/** Takes off the card, in place, every date the person never said. Returns
 *  the fields it took off. */
export function dropUnsaidDates(call: ToolCall, kinds: readonly KindRec[], said: string): string[] {
  const w = writing(call, kinds);
  if (!w || SAID_A_DATE.test(said)) return [];
  const dates = (w.kind.fields ?? []).filter((f) => f.type === "date" || f.type === "datetime").map((f) => f.name);
  const gone = dates.filter((n) => !blank(w.fields[n]));
  for (const n of gone) delete w.fields[n];
  return gone;
}

const isMoney = (f: Field): boolean => !!f.money || (!!f.fieldRole && MONEY_ROLES.has(f.fieldRole));
const isPlace = (f: Field): boolean => f.name === "location_id";

/** The message to hand back when the person said a price or a place the
 *  kind keeps and the create leaves it out, or null. */
export function saidButLeftOff(call: ToolCall, kinds: readonly KindRec[], said: string): string | null {
  const w = writing(call, kinds);
  if (!w) return null;
  const fields = (w.kind.fields ?? []).filter((f) => !f.readOnly);
  const missing: string[] = [];
  const money = fields.filter(isMoney);
  const price = SAID_A_PRICE.exec(said);
  if (price && money.length && money.every((f) => blank(w.fields[f.name]))) {
    const f = money[0]!;
    missing.push(`the price they said ("${price[0].trim()}") goes in fields.${f.name}${f.money === "cents" ? " in cents ($99 is 9900)" : ""}`);
  }
  const place = SAID_A_PLACE.exec(said);
  const where = fields.find(isPlace);
  if (place && where && blank(w.fields[where.name])) {
    missing.push(`where they said it is ("${place[0].trim()}") goes in fields.${where.name}, that place's id (search_records finds it; if there is no such place, say so)`);
  }
  if (!missing.length) return null;
  return `Not proposed yet: ${missing.join("; and ")}. Call again with ${missing.length === 1 ? "it" : "them"} filled from what the person said, or tell them why not.`;
}
