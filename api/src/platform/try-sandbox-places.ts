// Named places in a seed, resolved to ids. Pure of the api environment so the
// rule is a test (try-sandbox-records.ts imports env on load).

/** A place by name: `{ "$location": "Fridge" }`. The seed cannot know an id
 *  the blueprint mints at install, and a grocery whose Storage says Fridge
 *  with a blank Location read as half filled in (2026-09-12). */
interface NamedLocation {
  $location: string;
}

function isNamedLocation(v: unknown): v is NamedLocation {
  return typeof v === "object" && v !== null && typeof (v as NamedLocation).$location === "string";
}

/** Every `$location` name in the seed, resolved to an id through the
 *  platform's location writer: an existing place of that name (the bundle's
 *  Fridge, Freezer, Pantry), else one made for it, inside the first area
 *  when there is one (a Counter belongs in the Kitchen). Names are matched
 *  without case. Best-effort: a name that cannot be resolved leaves the
 *  record where it would have been, unplaced. */
export async function resolveNamedLocations(
  orgId: string,
  requests: ReadonlyArray<{ body?: Record<string, unknown> }>,
  writer: {
    listForMatch?: (orgId: string) => Promise<Array<{ id: string; name: string; parentId?: string | null }>>;
    create: (orgId: string, fields: Record<string, unknown>) => Promise<string>;
  } | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = new Set<string>();
  for (const r of requests) for (const v of Object.values(r.body ?? {})) if (isNamedLocation(v)) wanted.add(v.$location.trim());
  if (wanted.size === 0 || !writer) return out;
  let existing: Array<{ id: string; name: string; parentId?: string | null }> = [];
  try {
    existing = writer.listForMatch ? await writer.listForMatch(orgId) : [];
  } catch {
    return out;
  }
  const byName = new Map(existing.map((l) => [l.name.trim().toLowerCase(), l.id]));
  // The kitchen: the first top-level place. A made-up shelf goes inside it.
  const root = existing.find((l) => !l.parentId)?.id ?? null;
  for (const name of wanted) {
    const key = name.toLowerCase();
    let id = byName.get(key);
    if (!id) {
      try {
        id = await writer.create(orgId, { name, kind: "container", ...(root ? { parent_id: root } : {}) });
        byName.set(key, id);
      } catch {
        continue;
      }
    }
    out.set(key, id);
  }
  return out;
}

export function resolveLocations(body: Record<string, unknown>, ids: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (isNamedLocation(v)) {
      const id = ids.get(v.$location.trim().toLowerCase());
      if (id) out[k] = id;
    } else {
      out[k] = v;
    }
  }
  return out;
}
