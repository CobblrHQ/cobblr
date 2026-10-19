// ── AI-reply JSON hygiene ────────────────────────────────────────────────────
// Every AI surface that asks a model for JSON (scan matchmaker, the bundle
// builder's intent-match + describe-it→bundle, barcode/photo identify) hits the
// same problem: cheaper / smaller models (Haiku, local Ollama) garble strict
// JSON — markdown fences, trailing commas, smart quotes, truncated output,
// unescaped quotes in a string. A single garble used to drop the whole result.
// These pure helpers recover the structured object from imperfect output, so
// ONE source of truth serves every module (modules can't import each other; they
// all import this contract). Each caller keeps its own thin wrapper for its
// shape (the matchmaker's `candidates`, core-authoring's `bundle`).

/** The wire engine's source-entity payload-key convention, in ONE place so
 *  emitters and the engine agree without anyone hardcoding a foreign kind.
 *  An emitter that references another entity puts its id under the key derived
 *  from that entity's kind: the suffix after `:` , camelCased, + "Id". So
 *  "inventory:part" → "partId", "purchases:order_item" → "orderItemId". The
 *  wire engine derives the same key from a binding's source_kind to read it
 *  back. (Lets `lists` restock whatever seeded a checked line without a
 *  `kind === "inventory:part"` branch — audit 2026-06-26 burn-down.) */
export function sourceIdKey(kind: string): string {
  const suffix = kind.split(":")[1] ?? "";
  const camel = suffix.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return `${camel}Id`;
}

/** Extract the first BALANCED `{…}` object from a model reply, tolerant of
 *  ```fences``` + leading/trailing prose. Brace-matches OUTSIDE strings; returns
 *  the object substring, or — if the output was truncated mid-object — from the
 *  first `{` to the end (repairJson then closes it). null if there's no `{`. */
export function extractJsonObject(s: string): string | null {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]! : s;
  const start = body.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return body.slice(start, i + 1);
  }
  return body.slice(start);
}

/** Best-effort repair of common cheap-model JSON breakage, applied only AFTER a
 *  clean parse fails: curly "smart quotes" used as delimiters → straight, drop
 *  trailing commas, terminate an unclosed string, and balance unclosed `{`/`[`
 *  (truncation). Quote/bracket tracking skips characters inside strings. A
 *  structural/semantic error survives untouched for the caller's validator. */
export function repairJson(s: string): string {
  let out = s.replace(/[“”]/g, '"').replace(/,(\s*[}\]])/g, "$1");
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  return out;
}

/** Parse a model JSON reply into an object, recovering from fences/prose/
 *  commas/smart-quotes/truncation. Layered: as-is → repaired. Returns the parsed
 *  value (typed by the caller) or null when nothing salvageable — the caller may
 *  then retry the model or fall back. */
export function parseJsonReply<T = unknown>(content: string): T | null {
  const obj = extractJsonObject(content);
  if (!obj) return null;
  for (const candidate of [obj, repairJson(obj)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try the next repair */
    }
  }
  return null;
}
