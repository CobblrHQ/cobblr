// The words on a thing's label, read off one photo (#6302): for a recount of
// things with no barcode (filament spools whose box is long gone). Only the
// words are read here. Which record they are is decided by the recount's own
// matching (recount-match.ts), by the names and field values already on
// record, never by the model.
import { ITEMS_OUTPUT_SCHEMA } from "@cobblr/platform-contract/ai-output-schemas";
import { ActionRefusal, platform } from "@cobblr/platform-contract";

export const LABEL_PROMPT =
  "This photo shows the label of ONE thing (a spool of filament, a can, a box). " +
  "Copy the words printed on the label, one line or phrase per entry: the brand, " +
  "what it is, its material, colour, size and weight as printed. Do not guess at " +
  "words you cannot read, and do not describe the photo.\n\n" +
  'Reply with ONLY a JSON object: {"items": [{"name": <a line of printed words>}]}.';

const MAX_WORDS = 400;

/** The model's answer as one line of words: every printed line kept, joined. */
export function labelWords(answer: string): string {
  const json = answer.trim().startsWith("{") ? answer.trim() : (answer.match(/\{[\s\S]*\}/)?.[0] ?? "");
  let raw: unknown;
  try {
    raw = json ? JSON.parse(json) : null;
  } catch {
    return "";
  }
  const items = Array.isArray((raw as { items?: unknown } | null)?.items) ? ((raw as { items: unknown[] }).items as Array<Record<string, unknown>>) : [];
  return items
    .map((i) => (typeof i.name === "string" ? i.name.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_WORDS);
}

export async function labelInPhoto(orgId: string, userId: string | null, fileId: string): Promise<string> {
  const file = (await platform().files.read(orgId, fileId, "medium")) ?? (await platform().files.read(orgId, fileId, "original"));
  if (!file) throw new ActionRefusal("That photo could not be read. Take it again.");
  let text: string;
  try {
    const r = await platform().ai.invoke({
      orgId,
      capability: "split-image",
      input: { output_schema: ITEMS_OUTPUT_SCHEMA, image_b64: Buffer.from(file.bytes).toString("base64"), image_media_type: file.mimeType, prompt: LABEL_PROMPT },
      source: { kind: "inventory:recount-label", id: fileId },
      userId,
      noAi: { byHand: "type what the label says, or tap the thing in the recount's list" },
    });
    text = r.text;
  } catch {
    throw new ActionRefusal("Reading a label needs an AI connection that can see pictures, and none answered. Type what the label says instead.");
  }
  const words = labelWords(text);
  if (!words) throw new ActionRefusal("No words could be read on that label. Take it closer, lit and in focus, or type what it says.");
  return words;
}
