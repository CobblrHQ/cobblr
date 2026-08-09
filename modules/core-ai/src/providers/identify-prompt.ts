// Shared prompt for the `identify-image` capability: free-form "what is in this
// photo?" → a structured draft row for the scan inbox. Both provider adapters
// (OpenAI, Anthropic) use it so the output shape is identical regardless of
// which model a workspace configures.
//
// ONE read, three answers. The model is already looking at the photo, so it also
// reports what it factually SEES (packaging state, pack-size text — the
// matchmaker's corroboration, which catches the unit-barcode-on-a-multipack
// trap) and HOW MANY distinct things are in frame (which is what lets the inbox
// offer a split). Both used to cost a SECOND vision call on the same bytes
// (`observeScanPhoto`), landing so much later than the name that a group photo's
// split offer popped in seconds afterwards and read as a bug.

/**
 * The prompt an `identify-image` call ACTUALLY sends.
 *
 * A caller may supply its own (`input.prompt`) — a vision question that wants the
 * identify plumbing (an image in, JSON out) but is not "what is this item?".
 * `detectSplitItems` is the one: it asks the model to find and BOX each distinct
 * thing in a group photo.
 *
 * It used to pass `prompt: SPLIT_PROMPT` and be **silently ignored**: the OpenAI
 * and Anthropic adapters hard-coded IDENTIFY_PROMPT and never looked at
 * `input.prompt`. So the model was asked the *identify* question, answered
 * `{name, brand, …}`, `items` was absent, and `detected.length` was ALWAYS 0. With
 * `bypass_cache: true` on top, every single split fired a guaranteed-fresh,
 * guaranteed-paid vision call that was structurally incapable of returning what it
 * asked for — and then silently fell back to names the identify pass had already
 * stored for free. It never worked once. (The edge-bridge adapter DID honour
 * `input.prompt`, which is how we know the intent was there and two adapters just
 * didn't implement it.)
 *
 * EVERY consumer of the identify prompt goes through here — the adapters that send
 * it AND the fingerprint that keys the cache on it. If those two resolved the
 * prompt separately they would drift, and a split call would be cached under the
 * hash of a prompt it never sent. That is the same class of bug as the cache key
 * itself; one function is the guardrail.
 */
export function identifyPromptFor(input: Record<string, unknown>): string {
  const custom = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (custom) return custom;
  return IDENTIFY_PROMPT + measurementContext(input);
}

export const IDENTIFY_PROMPT =
  "Identify the main physical item in this photo as if cataloguing it " +
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
  'Also report "observations": 2-3 short factual sentences on what is ' +
  "physically present — how many retail units are visible (one loose unit, a " +
  "sealed multipack of N, a shelf of several), the packaging state, and any " +
  "label text you can read (QTY, pack size, model/SKU, size). Facts only: no " +
  "speculation, no marketing language.\n\n" +
  'Also report "distinct_items": how many DIFFERENT things are pictured. ' +
  "Several units of the SAME product is a QUANTITY, not different items — a " +
  "sealed 10-pack of one screw, or three identical mugs, is 1. A penguin " +
  "humidifier next to a frog humidifier is 2. Most photos are 1. When it is 2 " +
  'or more, list them in "items" — one entry per DIFFERENT thing, each named as ' +
  "specifically as the photo allows, with how many of that one are visible — " +
  'and let "name" describe the group as a whole. Otherwise "items" is [].\n\n' +
  "If the item has an obvious single COLOUR (a garment, a tool body, a phone " +
  "case), name it in plain English (\"black\", \"navy\", \"red\"). Use the " +
  "colour of the ITEM, not its packaging. Omit it for something with no one " +
  "colour, and never guess from a colour CODE you cannot interpret.\n\n" +
  'Reply with ONLY a JSON object: {"name": <string>, "brand": <string|null>, ' +
  '"color": <the item\'s colour in plain English, else null>, ' +
  '"category": <string|null>, "entity_type": "asset"|"part"|null, ' +
  '"series": <the series/franchise name if this is part of one, else null>, ' +
  '"barcode": <the UPC/EAN digits if clearly legible, else null>, ' +
  '"serial_number": <the serial number / service tag read verbatim if clearly legible, else null>, ' +
  '"observations": <string>, "distinct_items": <integer>, ' +
  '"items": [{"name": <string>, "brand": <string|null>, "qty": <integer>}], ' +
  '"confidence": <0..1, how sure you are>}. If the photo is unclear, empty, or ' +
  "not an identifiable object, reply name \"\" and confidence 0.";

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
  // The user's corrections, OLDEST first. They accumulate: a later one can
  // contradict an earlier one, or be about something else entirely, so the model
  // is shown all of them and told how to weigh them rather than being handed only
  // the newest (which silently discarded, say, a colour when the next hint was
  // about size).
  // Categories this workspace is ALREADY using. Every item is identified on its
  // own, so without this each call invents its own wording and siblings drift
  // apart by construction - three shirts scanned together came back "apparel",
  // "apparel" and "clothing" (reported 2026-07-30). Showing the vocabulary is the
  // cheapest fix: reuse beats reconciliation.
  const known = Array.isArray(input.known_categories)
    ? (input.known_categories as unknown[])
        .filter((c): c is string => typeof c === "string" && !!c.trim())
        .map((c) => c.trim())
        .slice(0, 24)
    : [];
  const hints = Array.isArray(input.user_hints)
    ? (input.user_hints as unknown[]).filter((h): h is string => typeof h === "string" && !!h.trim()).map((h) => h.trim())
    : [];
  const single = typeof input.user_hint === "string" ? input.user_hint.trim() : "";
  if (single && !hints.some((h) => h.toLowerCase() === single.toLowerCase())) hints.push(single);
  const hint = hints.length === 1 ? hints[0]! : "";
  let out = "";
  if (parts.length) {
    out +=
      "\n\nThese precise measurements + observations were captured at a measuring " +
      "bench — treat them as ground truth and use them to identify the item " +
      "specifically (they override anything ambiguous in the photo):\n" +
      parts.join("\n");
  }
  if (hints.length > 1) {
    // Several corrections. State the ordering rule explicitly — a model given a
    // bare list will otherwise treat them as equally current, and two colours in
    // that list is a coin flip.
    out +=
      "\n\nThe user has told you the following about this item, OLDEST FIRST. " +
      "These are AUTHORITATIVE corrections and they OVERRIDE your own read of the " +
      "photo. Weigh them like this: where two of them CONFLICT (they state a " +
      "different value for the same thing), the LATER one wins and the earlier is " +
      "obsolete. Where they concern DIFFERENT things, they ALL still apply " +
      "together. The last one is the most recent thing they told you.\n" +
      hints.map((h, i) => `  ${i + 1}. "${h}"${i === hints.length - 1 ? "  <- most recent" : ""}`).join("\n");
  } else if (hint) {
    out +=
      `\n\nThe user says this item IS: "${hint}". This is an AUTHORITATIVE ` +
      "correction — identify THAT specific item and return it as the name, even " +
      "if it isn't the most prominent object in the frame (it may be inside, " +
      "attached to, or partly hidden by another object). The user's words " +
      "override your own read of the photo; do NOT keep the previously-identified " +
      "item if it conflicts with this.";
  }
  if (known.length) {
    out +=
      "\n\nThis workspace already files things under these categories: " +
      known.join(", ") +
      ". If the item belongs in one of them, answer with that EXACT wording - " +
      "reusing an existing category is always better than a synonym of it " +
      "(\"apparel\" when the workspace says \"Clothing\" splits one shelf in two). " +
      "Only propose a new category when none of these genuinely fit.";
  }
  return out;
}
