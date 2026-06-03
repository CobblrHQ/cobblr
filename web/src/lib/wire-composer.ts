// Pure logic for the no-code wire composer (web/src/components/WireComposer).
// Kept out of the component so it can be unit-tested: the recurrence→RRULE
// builder, the {{token}} extractor, and the plain-language wire preview.

export type TriggerType =
  | "user-invoked"
  | "event"
  | "on-create"
  | "on-update"
  | "on-delete"
  | "schedule";

/** What the user picks under "WHEN" — friendly labels over the raw trigger
 *  types, plus the companion input each one needs. */
export const TRIGGER_OPTIONS: {
  value: TriggerType;
  label: string;
  needs: "event" | "schedule" | "none";
}[] = [
  { value: "event", label: "Something happens (an event fires)", needs: "event" },
  { value: "on-create", label: "A record is created", needs: "none" },
  { value: "on-update", label: "A record is updated", needs: "none" },
  { value: "on-delete", label: "A record is deleted", needs: "none" },
  { value: "schedule", label: "On a schedule", needs: "schedule" },
  { value: "user-invoked", label: "I click a button on the record", needs: "none" },
];

// ─────────────────────────── recurrence → RRULE ───────────────────────────

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY";

export interface Recurrence {
  freq: Freq;
  interval: number; // "every N"
  byday: string[]; // WEEKLY: ["MO","WE"] (iCal 2-letter codes)
  bymonthday: number; // MONTHLY: 1..31, or -1 for "last day"
}

export const WEEKDAYS: { code: string; label: string }[] = [
  { code: "MO", label: "Mon" },
  { code: "TU", label: "Tue" },
  { code: "WE", label: "Wed" },
  { code: "TH", label: "Thu" },
  { code: "FR", label: "Fri" },
  { code: "SA", label: "Sat" },
  { code: "SU", label: "Sun" },
];

export const DEFAULT_RECURRENCE: Recurrence = {
  freq: "WEEKLY",
  interval: 1,
  byday: ["MO"],
  bymonthday: 1,
};

/** Build an iCal RRULE string from the structured recurrence. */
export function buildRRule(r: Recurrence): string {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === "WEEKLY" && r.byday.length > 0) {
    parts.push(`BYDAY=${r.byday.join(",")}`);
  }
  if (r.freq === "MONTHLY") parts.push(`BYMONTHDAY=${r.bymonthday}`);
  return parts.join(";");
}

const ORD = (n: number): string => {
  if (n === -1) return "last day";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** Plain-language label for a recurrence ("every 2 weeks on Mon, Wed"). */
export function describeRecurrence(r: Recurrence): string {
  const every = r.interval > 1 ? `every ${r.interval} ` : "every ";
  if (r.freq === "DAILY") return r.interval > 1 ? `${every}days` : "every day";
  if (r.freq === "WEEKLY") {
    const days = r.byday.length
      ? " on " +
        r.byday
          .map((c) => WEEKDAYS.find((d) => d.code === c)?.label ?? c)
          .join(", ")
      : "";
    return (r.interval > 1 ? `${every}weeks` : "every week") + days;
  }
  return (r.interval > 1 ? `${every}months` : "every month") + ` on the ${ORD(r.bymonthday)}`;
}

// ─────────────────────────── template tokens ───────────────────────────

/** The distinct field names referenced as {{field}} (or {{field | default: …}})
 *  in a template. Used to validate against the source kind's fields. */
export function extractTokens(template: string): string[] {
  const re = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|[^}]*)?\}\}/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) out.add(m[1]!);
  return [...out];
}

/** Insert a {{field}} token into `template` at `caret` (end if undefined). */
export function insertToken(template: string, field: string, caret?: number): string {
  const tok = `{{${field}}}`;
  if (caret === undefined || caret > template.length) return template + tok;
  return template.slice(0, caret) + tok + template.slice(caret);
}

// ─────────────────────────── wire target ───────────────────────────

export type WireTarget = "self" | { rel: string; dir?: "out" | "in"; kind?: string };

// ─────────────────────────── preview sentence ───────────────────────────

export interface WirePreviewInput {
  triggerType: TriggerType;
  triggerEvent?: string | null;
  recurrence?: Recurrence | null;
  sourceLabel: string; // e.g. "Part"
  actionLabel: string; // e.g. "Adjust part stock"
  target?: WireTarget;
}

/** A readable one-liner describing what the wire will do. */
export function describeWire(i: WirePreviewInput): string {
  const src = i.sourceLabel || "record";
  const onTarget =
    i.target && i.target !== "self"
      ? ` on the ${i.target.kind || "related"} ${i.target.dir === "in" ? "pointing at" : "linked to"} it`
      : "";
  const doPart = `“${i.actionLabel}”${onTarget}`;
  switch (i.triggerType) {
    case "event":
      return `When the event ${i.triggerEvent ? `“${i.triggerEvent}”` : "(pick one)"} fires → ${doPart}.`;
    case "on-create":
      return `When a ${src} is created → ${doPart}.`;
    case "on-update":
      return `When a ${src} is updated → ${doPart}.`;
    case "on-delete":
      return `When a ${src} is deleted → ${doPart}.`;
    case "schedule":
      return `${i.recurrence ? capitalize(describeRecurrence(i.recurrence)) : "On a schedule"} → ${doPart} for each ${src}.`;
    case "user-invoked":
      return `Show a “${i.actionLabel}” button on each ${src} → runs ${doPart} when clicked.`;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
