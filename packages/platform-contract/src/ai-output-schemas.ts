// The shapes AI answers must keep (#5790): JSON Schemas a caller passes as
// `input.output_schema`. Every provider path sends the schema on (Ollama's
// `format`, an OpenAI-compatible `response_format`), and the router checks the
// answer against it, so an answer in a layout of the model's own is a failed
// call another provider may answer, never a success its parser drops.
//
// Each requires only what its parser cannot do without. A schema stricter
// than its parser turns good answers into failures; one looser than it lets
// the bug back in. Shapes shared by a prompt the adapter writes and callers in
// other modules live here.

type Schema = Record<string, unknown>;

export const TEXT_OR_NULL: Schema = { type: ["string", "null"] };
export const NUMBER_OR_NULL: Schema = { type: ["number", "null"] };

/** An object that must carry these keys, typed where given. */
export function objectWith(required: readonly string[], properties: Record<string, Schema> = {}): Schema {
  return { type: "object", required: [...required], properties };
}

/** An array of objects that must each carry these keys. */
export function listOf(required: readonly string[], properties: Record<string, Schema> = {}): Schema {
  return { type: "array", items: objectWith(required, properties) };
}

/** The identify prompt (identify-prompt.ts IDENTIFY_PROMPT): `name`, empty when
 *  the photo is a receipt or nothing identifiable. */
export const IDENTIFY_OUTPUT_SCHEMA = objectWith(["name"], { name: TEXT_OR_NULL });

/** The first-look prompt (GLANCE_PROMPT): a name and how sure. */
export const GLANCE_OUTPUT_SCHEMA = objectWith(["name", "confidence"], { name: TEXT_OR_NULL, category: TEXT_OR_NULL, confidence: NUMBER_OR_NULL });

/** classify-image's labels form: each a label and its confidence, or a bare label. */
export const LABELS_OUTPUT_SCHEMA = objectWith(["labels"], {
  labels: { type: "array", items: { anyOf: [{ type: "string" }, objectWith(["label"], { label: { type: "string" }, confidence: NUMBER_OR_NULL })] } },
});

/** A list of things seen in a photo, each with its name. */
export const ITEMS_OUTPUT_SCHEMA = objectWith(["items"], { items: listOf(["name"], { name: TEXT_OR_NULL }) });

/** A yes/no/unsure verdict with its reason. */
export const VERDICT_OUTPUT_SCHEMA = objectWith(["match"], { match: { type: "string" }, reason: TEXT_OR_NULL });

/** A workspace design (the builder's compile prompt): an object, its parts
 *  checked by the builder's own validator. */
export const DESIGN_OUTPUT_SCHEMA = objectWith([]);
