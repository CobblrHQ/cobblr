// The FEATURE index — search finds the APP, not just your data (the author: typed
// "edge bridge" into search and nothing came back; features were only
// reachable "where you use them"). One curated list consumed by both the ⌘K
// palette and the header SearchBar. Keywords are the words a person would
// actually type, including feature names we don't use in the UI copy.
export interface FeatureHit {
  label: string;
  hint: string;
  route: string;
  keywords: string;
}

export const FEATURE_INDEX: FeatureHit[] = [
  { label: "Edge bridges", hint: "see + manage your on-site bridges", route: "/configuration/edge", keywords: "edge bridge adapter relay agent bambu lightburn on-site local tunnel device gateway" },
  { label: "Digital Fabrication", hint: "send files to printers & machines", route: "/configuration/digifab", keywords: "digifab print farm fdm monster octoprint machine manager job fleet gcode" },
  { label: "Scan Inbox", hint: "review + file captures", route: "/scan", keywords: "scan inbox barcode photo capture review file queue" },
  { label: "Scanner (camera)", hint: "scan a barcode now", route: "/scan/camera", keywords: "camera scanner scan barcode photo upc" },
  { label: "Pair your phone", hint: "phone camera → this workspace", route: "/scan", keywords: "pair phone qr mobile handoff scanner" },
  { label: "Build with AI", hint: "describe what you have", route: "/build?mode=workspace", keywords: "build ai builder describe generate workspace design custom setup" },
  { label: "Your app (generate)", hint: "a member page from your trackers", route: "/build?mode=app", keywords: "your app generate member page worker app player" },
  { label: "Setups & trackers", hint: "ready-made bundles", route: "/bundles", keywords: "setups trackers bundles marketplace install recipes skins" },
  { label: "Configuration", hint: "modules, fields, wires, everything", route: "/configuration", keywords: "configuration settings customize workspace modules admin" },
  { label: "Custom fields", hint: "per-kind field definitions", route: "/fields", keywords: "fields custom field defs columns choices computed" },
  { label: "AI connections", hint: "connect a provider / local AI", route: "/configuration/ai", keywords: "ai provider ollama claude openai connect llm smart matching" },
  { label: "Your connections", hint: "personal AI + edge relays", route: "/me/connections", keywords: "personal connections byo credentials relay ai keys" },
  { label: "API tokens", hint: "tokens for scripts + bridges", route: "/configuration/tokens", keywords: "api token key script bridge automation" },
  { label: "Calendar", hint: "everything with a date, one view", route: "/calendar", keywords: "calendar dates ical schedule month" },
  { label: "Locations", hint: "rooms, shelves, bins", route: "/locations", keywords: "locations rooms bins shelves places where" },
  { label: "Labels & printing", hint: "QR labels, templates, print queue", route: "/labels", keywords: "labels qr print sticker template queue" },
  { label: "Members & sharing", hint: "invite people to this workspace", route: "/configuration/members", keywords: "members invite share people roles portal access" },
  { label: "Backup & blueprints", hint: "export / restore the workspace", route: "/configuration/backup", keywords: "backup export blueprint restore download drive" },
  { label: "Maintenance", hint: "service log across everything", route: "/configuration/maintenance", keywords: "maintenance service overdue schedule log" },
  { label: "Units", hint: "the quantity vocabulary", route: "/configuration/units", keywords: "units gram meter each vocabulary quantity" },
];

/** Rank features for a query: label-prefix > label-contains > keyword hit. */
export function searchFeatures(q: string, limit = 5): FeatureHit[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  return FEATURE_INDEX.map((f) => {
    const l = f.label.toLowerCase();
    const r = l.startsWith(s) ? 3 : l.includes(s) ? 2 : f.keywords.includes(s) || s.split(/\s+/).every((w) => f.keywords.includes(w)) ? 1 : 0;
    return { f, r };
  })
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r)
    .slice(0, limit)
    .map((x) => x.f);
}
