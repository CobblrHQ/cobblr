// Turning "what the AI just did for you" into something the workspace can do
// again WITHOUT the AI.
//
// The no-AI ruleset answers with TEXT. That is the whole of it: 26 keyword
// rules, each returning a paragraph. So a workspace with no AI can be told how
// to add a location and cannot be asked to add twelve.
//
// But every write Ask Cobb performs is already recorded, and once the ledger
// also remembers the message that caused it, each successful interaction is a
// worked example: this sentence produced these operations. Generalise the
// example and you have a command:
//
//   "make rack 1 through 12 in Den"
//     → 12 × create core-locations:location {name: "Rack <n>", parent: "Den"}
//     → template: make {word} {from} through {to} in {container}
//
// Two jobs, both pure and both here so they can be tested without a database:
//   deriveCommand  — example  → template (what the corpus is FOR)
//   bindCommand    — template → concrete operations for a new message
//
// Deliberately conservative. A template that fires on the wrong sentence writes
// to someone's workspace, so anything it cannot explain from the example is a
// reason to derive NOTHING. A missed generalisation costs a person one more
// question to an AI; a wrong one costs them their data.

import { compileTemplate, type CommandSlot } from "@cobblr/platform-contract";

export { compileTemplate };

/** One thing that was done: a chat write, as the ledger records it. */
export interface Operation {
  tool: "create" | "update" | "delete" | "action";
  entity_kind: string;
  /** Which record, for the operations that act on one. A taught command binds
   *  this from what it is told; a COMPUTED one works it out by looking (see
   *  computed-commands.ts), which is the only way "delete duplicates" can name
   *  anything at all. */
  entity_id?: string;
  action_id?: string | null;
  /** create/update fields, or an action's args. */
  payload: Record<string, unknown>;
}

/** Re-exported so this module's callers have one name for it. */
export type Slot = CommandSlot;

export interface LearnedCommand {
  /** Human-readable, with {slots}: "make {label} {from} through {to} in {container}". */
  template: string;
  /** Anchored regex with one capture group per slot, in `slots` order. */
  pattern: string;
  slots: Slot[];
  /** What to do, with slot references where the example had literals. */
  plan: Operation[];
  /** For a range command: the field whose value counts, e.g. "name". */
  repeatField?: string;
  /** The literal that surrounds the counter: "Rack {n}". */
  repeatShape?: string;
}

const NUM = /^-?\d+$/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A literal, matched as a WHOLE word or phrase.
 *
 *  Not a substring: the prefix "p" appears inside the word "prefix", and
 *  treating that as an occurrence turned "set the code prefix for printers to
 *  p" into "set the code {prefix}refix for {group_key} to p" — a template that
 *  is both wrong and unrunnable. If a value only shows up inside another word,
 *  it is a coincidence and not something the sentence is saying. */
function literalRegex(value: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegex(value)}(?![a-z0-9])`, "i");
}

/** Is this value actually written in the message, as its own word? */
function saidIn(message: string, value: string): boolean {
  return literalRegex(value).test(message);
}

/** Words of a message, lowercased, punctuation dropped — the same shape the
 *  basics matcher normalizes to, so the two agree about what a message "is". */
function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9'\s]+/g, " ").split(/\s+/).filter(Boolean);
}

/** Every string value in a payload, with the key that held it. */
function literals(payload: Record<string, unknown>): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, v] of Object.entries(payload)) {
    if (typeof v === "string" && v.trim()) out.push({ key, value: v.trim() });
    else if (typeof v === "number") out.push({ key, value: String(v) });
  }
  return out;
}

/** Split "Rack 12" into its constant part and its counter. */
function counterOf(value: string): { shape: string; n: number } | null {
  const m = /^(.*?)(\d+)(\D*)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return null;
  return { shape: `${m[1]}{n}${m[3]}`, n };
}

/**
 * Derive a reusable command from ONE successful interaction.
 *
 * Returns null whenever the example cannot be explained — which is most of the
 * time, and is the correct answer. A command is only derived when every part of
 * it is visible in both the message and what was done.
 */
export function deriveCommand(message: string, ops: Operation[]): LearnedCommand | null {
  if (!message.trim() || ops.length === 0) return null;
  // One shape of operation only. A message that created a location AND adjusted
  // stock is a conversation, not a command.
  const kinds = new Set(ops.map((o) => `${o.tool}|${o.entity_kind}|${o.action_id ?? ""}`));
  if (kinds.size !== 1) return null;

  const first = ops[0]!;

  // ── the repeated case: N operations that differ only by a counter ─────────
  if (ops.length > 1) {
    const shapes = ops.map((o) => {
      const counters = literals(o.payload)
        .map((l) => ({ key: l.key, ...(counterOf(l.value) ?? { shape: "", n: NaN }) }))
        .filter((c) => Number.isFinite(c.n));
      return counters;
    });
    // Exactly one field carries the counter, and every op agrees on its shape.
    const field = shapes[0]?.[0];
    if (!field) return null;
    const sameShape = shapes.every((s) => s.length === 1 && s[0]!.key === field.key && s[0]!.shape === field.shape);
    if (!sameShape) return null;
    const ns = shapes.map((s) => s[0]!.n).sort((a, b) => a - b);
    const contiguous = ns.every((n, i) => i === 0 || n === ns[i - 1]! + 1);
    if (!contiguous) return null;
    const from = ns[0]!;
    const to = ns[ns.length - 1]!;
    // Both ends must be IN the message, or we are inventing the range.
    const msgWords = words(message);
    if (!msgWords.includes(String(from)) || !msgWords.includes(String(to))) return null;

    // Any other literal shared by the message and every op becomes a slot
    // (the container the racks went into).
    const shared = literals(first.payload).filter(
      (l) => l.key !== field.key && saidIn(message, l.value) && ops.every((o) => o.payload[l.key] === l.value),
    );

    const slots: Slot[] = [
      { name: "from", kind: "number" },
      { name: "to", kind: "number" },
      ...shared.map((l) => ({ name: l.key, kind: "text" as const })),
    ];
    let template = message.trim();
    let pattern = escapeRegex(message.trim());
    // Replace the two numbers and each shared literal with slots, longest
    // literal first so a short one cannot cut a longer one in half.
    for (const l of [...shared].sort((a, b) => b.value.length - a.value.length)) {
      template = template.replace(literalRegex(l.value), `{${l.key}}`);
      pattern = pattern.replace(literalRegex(escapeRegex(l.value)), "(.+?)");
    }
    template = template.replace(new RegExp(`\\b${from}\\b`), "{from}").replace(new RegExp(`\\b${to}\\b`), "{to}");
    pattern = pattern.replace(new RegExp(`\\b${from}\\b`), "(\\d+)").replace(new RegExp(`\\b${to}\\b`), "(\\d+)");
    // Slot order must match capture order, which is left-to-right in the text.
    const order = slots
      .map((s) => ({ s, at: template.indexOf(`{${s.name}}`) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((x) => x.s);
    if (order.length !== slots.length) return null;

    return {
      template,
      pattern: `^\\s*${pattern}\\s*$`,
      slots: order,
      // The PLAN has to carry slots too, not just the template. Leaving the
      // shared literals in place made every replay write the example's own
      // values: "make rack 5 through 8 in Garage" created four racks in Den.
      plan: [
        {
          ...first,
          payload: {
            ...first.payload,
            ...Object.fromEntries(shared.map((l) => [l.key, `{${l.key}}`])),
            [field.key]: `{${field.key}}`,
          },
        },
      ],
      repeatField: field.key,
      repeatShape: field.shape,
    };
  }

  // ── the single case: one operation, its literals lifted out of the text ──
  const shared = literals(first.payload).filter((l) => saidIn(message, l.value));
  if (shared.length === 0) return null;
  let template = message.trim();
  let pattern = escapeRegex(message.trim());
  const payload: Record<string, unknown> = { ...first.payload };
  for (const l of [...shared].sort((a, b) => b.value.length - a.value.length)) {
    template = template.replace(literalRegex(l.value), `{${l.key}}`);
    pattern = pattern.replace(literalRegex(escapeRegex(l.value)), NUM.test(l.value) ? "(\\d+)" : "(.+?)");
    payload[l.key] = `{${l.key}}`;
  }
  const slots = shared
    .map((l) => ({ slot: { name: l.key, kind: (NUM.test(l.value) ? "number" : "text") as Slot["kind"] }, at: template.indexOf(`{${l.key}}`) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.slot);
  if (slots.length !== shared.length) return null;

  return { template, pattern: `^\\s*${pattern}\\s*$`, slots, plan: [{ ...first, payload }] };
}

/**
 * Match a new message against a learned command and produce the operations it
 * means. Null when it does not apply — never a guess.
 */
export function bindCommand(cmd: LearnedCommand, message: string): Operation[] | null {
  let re: RegExp;
  try {
    re = new RegExp(cmd.pattern, "i");
  } catch {
    return null;
  }
  const m = re.exec(message.trim());
  if (!m) return null;
  const values: Record<string, string> = {};
  cmd.slots.forEach((s, i) => {
    values[s.name] = (m[i + 1] ?? "").trim();
  });

  const fill = (v: unknown): unknown =>
    typeof v === "string" ? v.replace(/\{([a-z0-9_]+)\}/gi, (_, k: string) => values[k] ?? `{${k}}`) : v;

  const base = cmd.plan[0]!;
  if (!cmd.repeatField) {
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(base.payload)) payload[k] = fill(v);
    return [{ ...base, payload }];
  }

  const from = Number(values.from);
  const to = Number(values.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  // A learned command must not be a way to create ten thousand records from one
  // sentence. Past a sane run it is a mistake, and a mistake at that size is
  // not one anybody wants to undo by hand.
  if (to - from + 1 > 200) return null;

  const ops: Operation[] = [];
  for (let n = from; n <= to; n++) {
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(base.payload)) {
      // The shape can carry slots of its own — a shipped command says
      // "{label} {n}" so one template numbers shelves, bays or bins. Fill the
      // slots first, then the counter, or every record is called "{label} 1".
      payload[k] =
        k === cmd.repeatField
          ? String(fill(cmd.repeatShape ?? "{n}")).replace("{n}", String(n))
          : fill(v);
    }
    ops.push({ ...base, payload });
  }
  return ops;
}
