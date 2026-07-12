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
  "If a UPC/EAN barcode is printed on the package and the digits are clearly " +
  "legible, read them.\n\n" +
  "If a serial number or service tag is printed on the item or its label and " +
  "clearly legible, read it VERBATIM (exactly the characters shown). Never " +
  "guess one, and never complete a partly-hidden or blurry one — omit it " +
  "instead. It is an identifier, not a description.\n\n" +
  "If the item is a titled work that belongs to a KNOWN SERIES or franchise — " +
  "a book in a series (Harry Potter, Little House on the Prairie), a film in a " +
  "franchise (John Wick), an album in a set — name that series. Only when you " +
  "actually recognise the series; never guess one from a generic title.\n\n" +
  'Reply with ONLY a JSON object: {"name": <string>, "brand": <string|null>, ' +
  '"category": <string|null>, "entity_type": "asset"|"part"|null, ' +
  '"series": <the series/franchise name if this is part of one, else null>, ' +
  '"barcode": <the UPC/EAN digits if clearly legible, else null>, ' +
  '"serial_number": <the serial number / service tag read verbatim if clearly legible, else null>, ' +
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
  // A user correction/hint OVERRIDES the visual read — the person telling you
  // "it's the headset" when the photo shows a carrying case means the item they
  // want is the headset (inside/attached), not the most prominent object. Trust
  // the words over the pixels; the hint may name a DIFFERENT item than the obvious one.
  const hint = typeof input.user_hint === "string" ? input.user_hint.trim() : "";
  let out = "";
  if (parts.length) {
    out +=
      "\n\nThese precise measurements + observations were captured at a measuring " +
      "bench — treat them as ground truth and use them to identify the item " +
      "specifically (they override anything ambiguous in the photo):\n" +
      parts.join("\n");
  }
  if (hint) {
    out +=
      `\n\nThe user says this item IS: "${hint}". This is an AUTHORITATIVE ` +
      "correction — identify THAT specific item and return it as the name, even " +
      "if it isn't the most prominent object in the frame (it may be inside, " +
      "attached to, or partly hidden by another object). The user's words " +
      "override your own read of the photo; do NOT keep the previously-identified " +
      "item if it conflicts with this.";
  }
  return out;
}
