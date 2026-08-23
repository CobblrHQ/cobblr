// Referring to an entity, or a person, from inside free text.
//
// Lives in the CONTRACT rather than in the module that first needed it, because
// two sides have to agree on it and a disagreement is silent in both
// directions: the server links a record the browser renders as plain text, or
// the browser draws a chip for something that was never stored. Neither throws.
// One implementation, imported by both, is the only version of this that cannot
// drift.
//
// It is also not discussion-specific. `[[<module>:<type>:<uuid>]]` is a
// portable reference to a record in prose, which is what any surface holding
// user-written text eventually wants: a knowledge entry, a note, a template.
//
// The tokens are STABLE IDS, never the name that was on screen when they were
// typed. So renaming a printer or a person updates every reference to them,
// everywhere, with no migration. It is the same rule tags follow, for the same
// reason: a stored name is a copy, and copies go stale.
//
//   [[user:<uuid>]]                  a person
//   [[cobb]]                         the assistant
//   [[<module>:<type>:<uuid>]]       a record
//
// Pure and dependency-free, so it can be tested on its own — worth doing rather
// than eyeballing, because a token pattern that is slightly too greedy quietly
// attributes text to the wrong record.

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/** `[[...]]` with no nesting and no whitespace inside: a token is machine
 *  written, so anything loose is prose that happens to use brackets. */
const TOKEN = /\[\[([^[\]\s]+)\]\]/g;
const USER = new RegExp(`^user:(${UUID})$`);
const ENTITY = new RegExp(`^([a-z0-9-]+):([a-z0-9_-]+):(${UUID})$`, "i");

/** One thing a body names. */
export type Mention =
  | { kind: "user"; userId: string }
  | { kind: "assistant" }
  | { kind: "entity"; targetModule: string; targetType: string; targetId: string };

/** One piece of a body: prose, or something it names. Rendering walks these so
 *  a mention can draw as a chip and everything else stays verbatim. */
export type TextPiece =
  | { t: "text"; value: string }
  | { t: "user"; id: string }
  | { t: "cobb" }
  | { t: "entity"; kind: string; id: string };

/** Read one token's payload, or null if it is just prose in brackets. */
function readToken(raw: string): Mention | null {
  if (raw === "cobb") return { kind: "assistant" };
  const u = USER.exec(raw);
  if (u) return { kind: "user", userId: u[1]!.toLowerCase() };
  const e = ENTITY.exec(raw);
  // A user token that failed the UUID test must NOT fall through to the entity
  // pattern, which would read "user:garbage" as a module named "user".
  if (e && e[1]!.toLowerCase() !== "user") {
    return {
      kind: "entity",
      targetModule: e[1]!,
      targetType: e[2]!,
      targetId: e[3]!.toLowerCase(),
    };
  }
  return null;
}

function keyOf(m: Mention): string {
  return m.kind === "user"
    ? `u:${m.userId}`
    : m.kind === "assistant"
      ? "a"
      : `e:${m.targetModule}:${m.targetType}:${m.targetId}`;
}

/** Every mention in a body, de-duplicated, in the order they appear.
 *
 *  Unknown token shapes are IGNORED rather than rejected: a body is prose, and
 *  writing `[[TODO]]` is not a mistake worth failing somebody's comment over. */
export function parseMentions(body: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(TOKEN)) {
    const mention = readToken(m[1]!);
    if (!mention) continue;
    const key = keyOf(mention);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mention);
  }
  return out;
}

/** Split a body into prose and mentions, preserving order and spacing.
 *
 *  The rendering half of the same grammar, here so it cannot disagree with the
 *  parsing half about what a token is. */
export function splitMentions(body: string): TextPiece[] {
  const out: TextPiece[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", value: body.slice(last, at) });
    const mention = readToken(m[1]!);
    if (!mention) out.push({ t: "text", value: m[0] });
    else if (mention.kind === "assistant") out.push({ t: "cobb" });
    else if (mention.kind === "user") out.push({ t: "user", id: mention.userId });
    else
      out.push({
        t: "entity",
        kind: `${mention.targetModule}:${mention.targetType}`,
        id: mention.targetId,
      });
    last = at + m[0].length;
  }
  if (last < body.length) out.push({ t: "text", value: body.slice(last) });
  return out;
}

/** Just the records named — what writes links. */
export function entityMentions(
  body: string,
): Array<{ targetModule: string; targetType: string; targetId: string }> {
  return parseMentions(body).filter(
    (m): m is Extract<Mention, { kind: "entity" }> => m.kind === "entity",
  );
}

/** Was the assistant summoned? */
export function mentionsAssistant(body: string): boolean {
  return parseMentions(body).some((m) => m.kind === "assistant");
}

/** The people named, for notification. */
export function userMentions(body: string): string[] {
  return parseMentions(body)
    .filter((m): m is Extract<Mention, { kind: "user" }> => m.kind === "user")
    .map((m) => m.userId);
}
