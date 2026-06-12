// Shared prompt for the `identify-image` capability: free-form "what is
// this ONE physical item?" → a structured draft row for the scan inbox.
// Both provider adapters (OpenAI, Anthropic) use it so the output shape
// is identical regardless of which model a workspace configures.

export const IDENTIFY_PROMPT =
  "Identify the ONE main physical item in this photo as if cataloguing it " +
  "for a workshop/maker inventory. Give a concise descriptive name (brand + " +
  "model + what it is when visible), the brand if legible, a coarse category " +
  "(one or two words, e.g. \"power tool\", \"fastener\", \"filament\", " +
  "\"electronics\"), and whether it's an \"asset\" (a discrete, individually-" +
  "tracked whole item — a tool, device, appliance, machine) or a \"part\" (a " +
  "component, consumable, material or supply).\n\n" +
  'Reply with ONLY a JSON object: {"name": <string>, "brand": <string|null>, ' +
  '"category": <string|null>, "entity_type": "asset"|"part"|null, ' +
  '"confidence": <0..1, how sure you are>}. If the photo is unclear, empty, or ' +
  "not a single identifiable object, reply name \"\" and confidence 0.";

/** Optional measurement + observation context for the Cataloging Bench. When a
 *  workspace captures physical measurements (caliper/scale) and visual
 *  observations at a measuring bench BEFORE identifying, fold them into the
 *  identify prompt — a photo can't tell you a thing is *exactly* 6.0 mm, but a
 *  caliper can, so the model disambiguates with hard data instead of guessing.
 *  Returns "" when neither is present (plain photo-identify stays unchanged). */
export function measurementContext(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const m = input.measurements;
  const o = input.observations;
  if (m && typeof m === "object" && Object.keys(m).length) {
    parts.push("Exact measurements (mm unless noted; weight in g): " + JSON.stringify(m));
  }
  if (o && typeof o === "object" && Object.keys(o).length) {
    parts.push("Visual observations: " + JSON.stringify(o));
  }
  if (!parts.length) return "";
  return (
    "\n\nThese precise measurements + observations were captured at a measuring " +
    "bench — treat them as ground truth and use them to identify the item " +
    "specifically (they override anything ambiguous in the photo):\n" +
    parts.join("\n")
  );
}
