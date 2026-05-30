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
