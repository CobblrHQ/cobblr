// The shape an AI answer must keep (#5790). A call that needs structured
// output passes `input.output_schema` (JSON Schema); every provider path
// sends it on (Ollama's `format`, an OpenAI-compatible `response_format`),
// and the router checks what came back against it here. An answer that
// ignores the shape is a failed call (`wrong_shape`), which another provider
// may answer: a local model writing its own JSON layout used to come back as
// a success that the caller's parser then quietly dropped.

import { aiAnswerText } from "@cobblr/platform-contract/ai-answer";
import { validateAgainst } from "./service-schema.js";

/** The JSON in a model's answer: the whole text, or a fenced block, or the
 *  first object or array in it, as the callers' own parsers read it. */
export function answerJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const tries = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) tries.push(fenced[1].trim());
  const o = text.indexOf("{"), oc = text.lastIndexOf("}");
  if (o >= 0 && oc > o) tries.push(text.slice(o, oc + 1));
  const a = text.indexOf("["), ac = text.lastIndexOf("]");
  if (a >= 0 && ac > a) tries.push(text.slice(a, ac + 1));
  for (const t of tries) {
    try {
      return { ok: true, value: JSON.parse(t) };
    } catch {
      /* the next reading */
    }
  }
  return { ok: false };
}

/** Why an answer misses the call's output schema, or null when it keeps to
 *  it (or the call named none). A chat turn that called a tool has no shape
 *  to keep: the tool call is the answer. */
export function wrongShape(input: Record<string, unknown>, result: unknown): string | null {
  const schema = input.output_schema;
  if (!schema || typeof schema !== "object") return null;
  if (result && typeof result === "object" && Array.isArray((result as { tool_calls?: unknown }).tool_calls)) return null;
  const text = aiAnswerText(result);
  const parsed = answerJson(text);
  const snippet = text.replace(/\s+/g, " ").slice(0, 160);
  if (!parsed.ok) {
    // JSON begun and cut short (an answer stopped at its token limit) is left
    // to the caller's parser, which may salvage it (the matchmaker does);
    // prose or a table with no JSON in it is the wrong shape.
    return /[[{]/.test(text) ? null : `no JSON in the answer ("${snippet}")`;
  }
  const check = validateAgainst(schema as Record<string, unknown>, undefined, parsed.value);
  return check.ok ? null : `${check.errors.slice(0, 3).join("; ")} ("${snippet}")`;
}
