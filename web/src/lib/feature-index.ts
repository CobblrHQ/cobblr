// The FEATURE index — search finds the APP, not just your data (the author: typed
// "edge bridge" into search and nothing came back; features were only
// reachable "where you use them"; then: "many things do not resolve in the
// global search — make sure it can help with all settings and system-type
// things"). One list consumed by both the ⌘K palette and the header SearchBar.
//
// Two sources, merged + deduped:
//   1. CURATED — task-first features with hand-tuned hints/routes (scan, build,
//      calendar, labels…), including entries not in the settings registry.
//   2. CONFIG_DESTINATIONS — the authoritative registry of EVERY workspace
//      settings/system destination (fields, permissions, backup, healthcheck,
//      OpenAPI…). Folding it in here means the registry can never drift from
//      search: add a settings page there and it's instantly findable.
// Keywords are the words a person would actually type, including feature names
// we don't use in the UI copy.
import { CONFIG_DESTINATIONS } from "./configuration-nav";

export interface FeatureHit {
  label: string;
  hint: string;
  route: string;
  keywords: string;
}

// CURATED must NOT collide by route with a registry destination. When it did,
// the same page carried two independently-maintained descriptions and they
// drifted; the dedup below silently picked the curated one, so editing the
// registry appeared to do nothing. Anything the registry owns (Edge bridges,
// Digifab, Units, Custom fields, Backup, Members, API tokens, Maintenance…) is
// deliberately absent here and folded in from CONFIG_DESTINATIONS instead.
// lint:config-routes enforces it.
//
// What's left is genuinely NOT in the settings registry: task-first entry
// points and pages that live elsewhere in the app.
const CURATED: FeatureHit[] = [
  { label: "Scan Inbox", hint: "review + file captures", route: "/scan", keywords: "scan inbox barcode photo capture review file queue" },
  { label: "Scanner (camera)", hint: "scan a barcode now", route: "/scan/camera", keywords: "camera scanner scan barcode photo upc" },
  { label: "Pair your phone", hint: "phone camera → this workspace", route: "/scan", keywords: "pair phone qr mobile handoff scanner" },
  { label: "Build with AI", hint: "describe what you have", route: "/build?mode=workspace", keywords: "build ai builder describe generate workspace design custom setup" },
  { label: "Your app (generate)", hint: "a member page from your trackers", route: "/build?mode=app", keywords: "your app generate member page worker app player" },
  { label: "Configuration", hint: "modules, fields, wires, everything", route: "/configuration", keywords: "configuration settings customize workspace modules admin" },
  { label: "Email in", hint: "forward receipts by email; reply-by-email", route: "/configuration/integrations#email-in", keywords: "email forward receipt receipts inbox mail forwarding address reply gmail scan invoice ingest" },
  { label: "Your connections", hint: "personal AI + edge relays", route: "/me/connections", keywords: "personal connections byo credentials relay ai keys" },
  { label: "Calendar", hint: "everything with a date, one view", route: "/calendar", keywords: "calendar dates ical schedule month" },
  { label: "Locations", hint: "rooms, shelves, bins", route: "/locations", keywords: "locations rooms bins shelves places where" },
  { label: "Labels & printing", hint: "QR labels, templates, print queue", route: "/labels", keywords: "labels qr print sticker template queue" },
];

/** A short right-hand hint from a registry destination's full description:
 *  the first clause, capped — the sidebar/tile description is a full sentence,
 *  too long for the palette's fixed-width hint column. */
function shortHint(desc: string): string {
  const clause = desc.split(/[—.,;(]/)[0]!.trim();
  return clause.length > 44 ? `${clause.slice(0, 42).trimEnd()}…` : clause;
}

/** Every settings/system destination, as a searchable feature. Keywords fold in
 *  the label + full description + the registry's own synonyms, so "audit" finds
 *  Activity log and "roles" finds Permissions even though the labels don't say
 *  those words. */
const CONFIG_AS_FEATURES: FeatureHit[] = CONFIG_DESTINATIONS.filter((d) => d.to).map((d) => ({
  label: d.label,
  hint: shortHint(d.description),
  route: d.to!,
  keywords: `${d.label} ${d.description} ${(d.keywords ?? []).join(" ")}`.toLowerCase(),
}));

/** CURATED first (better hints + task routes; kept in full — its intentional
 *  same-route pairs like /scan and /build?mode=… must all survive), then every
 *  settings destination that doesn't collide with a curated entry by label OR
 *  route. So a page in both lists — Units, Custom fields, Bundles ("Setups &
 *  trackers"), Locations — shows exactly once, and the rest of the settings
 *  registry (Permissions, Backup, Healthcheck, OpenAPI…) becomes findable. */
export const FEATURE_INDEX: FeatureHit[] = (() => {
  const seenLabel = new Set(CURATED.map((f) => f.label.toLowerCase().trim()));
  const seenRoute = new Set(CURATED.map((f) => f.route.split("?")[0]!));
  const out: FeatureHit[] = [...CURATED];
  for (const f of CONFIG_AS_FEATURES) {
    const lk = f.label.toLowerCase().trim();
    const rk = f.route.split("?")[0]!;
    if (seenLabel.has(lk) || seenRoute.has(rk)) continue;
    seenLabel.add(lk);
    seenRoute.add(rk);
    out.push(f);
  }
  return out;
})();

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
