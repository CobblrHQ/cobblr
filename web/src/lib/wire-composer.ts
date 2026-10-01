// Pure logic for the no-code wire composer (web/src/components/WireComposer).
// Kept out of the component so it can be unit-tested: the recurrence→RRULE
// builder, the {{token}} extractor, and the plain-language wire preview.

import { withArticle } from "@cobblr/platform-contract/plural";

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

/** Reverse of buildRRule: parse an iCal RRULE back into a Recurrence so a
 *  schedule wire can be prefilled into the composer for editing. Unknown /
 *  malformed input falls back to DEFAULT_RECURRENCE. */
export function parseRRule(rrule: string | null | undefined): Recurrence {
  if (!rrule) return { ...DEFAULT_RECURRENCE };
  const parts: Record<string, string> = {};
  for (const seg of rrule.split(";")) {
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  const freq = (["DAILY", "WEEKLY", "MONTHLY"].includes(parts.FREQ ?? "") ? parts.FREQ : "WEEKLY") as Freq;
  return {
    freq,
    interval: Math.max(1, parseInt(parts.INTERVAL ?? "1", 10) || 1),
    byday: parts.BYDAY ? parts.BYDAY.split(",").filter((c) => WEEKDAYS.some((d) => d.code === c)) : ["MO"],
    bymonthday: parts.BYMONTHDAY ? parseInt(parts.BYMONTHDAY, 10) || 1 : 1,
  };
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
  /** The wire acts on no record: it runs once per event or tick. */
  recordless?: boolean;
}

/** A readable one-liner describing what the wire will do. */
export function describeWire(i: WirePreviewInput): string {
  const src = i.sourceLabel || "record";
  if (i.recordless) {
    const doOnce = `“${i.actionLabel}” once`;
    if (i.triggerType === "schedule")
      return `${i.recurrence ? capitalize(describeRecurrence(i.recurrence)) : "On a schedule"} → ${doOnce}.`;
    return `When the event ${i.triggerEvent ? `“${i.triggerEvent}”` : "(pick one)"} fires → ${doOnce}.`;
  }
  const onTarget =
    i.target && i.target !== "self"
      ? ` on the ${i.target.kind || "related"} ${i.target.dir === "in" ? "pointing at" : "linked to"} it`
      : "";
  const doPart = `“${i.actionLabel}”${onTarget}`;
  switch (i.triggerType) {
    case "event":
      return `When the event ${i.triggerEvent ? `“${i.triggerEvent}”` : "(pick one)"} fires → ${doPart}.`;
    case "on-create":
      return `When ${withArticle(src)} is created → ${doPart}.`;
    case "on-update":
      return `When ${withArticle(src)} is updated → ${doPart}.`;
    case "on-delete":
      return `When ${withArticle(src)} is deleted → ${doPart}.`;
    case "schedule":
      return `${i.recurrence ? capitalize(describeRecurrence(i.recurrence)) : "On a schedule"} → ${doPart} for each ${src}.`;
    case "user-invoked":
      return `Show a “${i.actionLabel}” button on each ${src} → runs ${doPart} when clicked.`;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─────────────────────────── a service's input ───────────────────────────

/** Triggers that make sense for a wire on no record: there is no record to
 *  be created, changed, deleted or carry a button. */
export const RECORDLESS_TRIGGERS: TriggerType[] = ["event", "schedule"];

export interface ServiceInputField {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "choice";
  options?: string[];
  required: boolean;
}

/** The fields a service asks for, read from its input schema's top-level
 *  properties. A property of a shape a text box cannot hold (an object, an
 *  array) is left out; the service's own defaults apply to it. */
export function serviceInputFields(schema: Record<string, unknown> | null | undefined): ServiceInputField[] {
  const props = (schema?.["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema?.["required"]) ? (schema!["required"] as string[]) : []);
  const out: ServiceInputField[] = [];
  for (const [name, p] of Object.entries(props)) {
    const label = typeof p["title"] === "string" ? (p["title"] as string) : name.replace(/_/g, " ");
    const base = { name, label, required: required.has(name) };
    if (Array.isArray(p["enum"])) out.push({ ...base, type: "choice", options: (p["enum"] as unknown[]).map(String) });
    else if (p["type"] === "number" || p["type"] === "integer") out.push({ ...base, type: "number" });
    else if (p["type"] === "boolean") out.push({ ...base, type: "boolean" });
    else if (p["type"] === undefined || p["type"] === "string") out.push({ ...base, type: "text" });
  }
  return out;
}

/** The input a wire stores: each value is a literal or a {{token}}; a number
 *  or a yes/no typed as one is stored as one, a token stays text and is
 *  filled in when the wire fires. Blank fields are left out. */
export function buildServiceInput(fields: ServiceInputField[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = (values[f.name] ?? "").trim();
    if (!v) continue;
    if (f.type === "number" && /^-?\d+(\.\d+)?$/.test(v)) out[f.name] = Number(v);
    else if (f.type === "boolean" && (v === "true" || v === "false")) out[f.name] = v === "true";
    else out[f.name] = v;
  }
  return out;
}

/** The stored input back as the form's text values (editing a wire). */
export function serviceInputValues(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([, v]) => v == null || typeof v !== "object")
      .map(([k, v]) => [k, v == null ? "" : String(v)]),
  );
}

/** What a wire on a service job's event can read, as {{event.*}} tokens. A
 *  finished job's answer is {{event.output.<field>}}, named by that service. */
export const SERVICE_EVENT_TOKENS = ["event.capability", "event.status", "event.jobId", "event.hop"] as const;
