// The last few places a person filed into, per workspace, on this device
// (#3902): the picker's Recent row. A convenience, so it lives in the
// browser and a failed read is simply no row.

const MAX = 3;
const key = (slug: string) => `cobblr.recent-locations.${slug}`;

export function recentLocations(slug: string): string[] {
  try {
    const raw = localStorage.getItem(key(slug));
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function noteRecentLocation(slug: string, id: string): void {
  try {
    const next = [id, ...recentLocations(slug).filter((x) => x !== id)].slice(0, MAX);
    localStorage.setItem(key(slug), JSON.stringify(next));
  } catch {
    /* storage unavailable: no Recent row, nothing else changes */
  }
}
