// Persisted ordering of top-level modules in the workspace navbar.
// Stored in localStorage as a JSON array of module names. Modules
// not in the saved order fall to the end (so newly enabled modules
// appear at the end of the nav, not at random positions). Modules
// in the saved order but missing from the input list are ignored.
//
// localStorage was chosen over server storage so the rename / nav
// order is a per-device personalisation rather than an org-wide
// edit — different team members can re-order their own view. If
// org-wide nav order becomes a requirement, promote this to a row
// on org_modules with a `position` column and a PATCH endpoint.

const KEY = (slug: string) => `cobblr:nav-order:${slug}`;

export function readNavOrder(slug: string): string[] {
  if (!slug) return [];
  try {
    const raw = localStorage.getItem(KEY(slug));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function writeNavOrder(slug: string, order: string[]) {
  if (!slug) return;
  try {
    localStorage.setItem(KEY(slug), JSON.stringify(order));
    // Same-tab listeners (the storage event only fires for *other*
    // tabs, so we emit our own bus event for the active tab too).
    window.dispatchEvent(new CustomEvent("cobblr:nav-order-changed", { detail: { slug } }));
  } catch {
    /* quota or disabled — silently keep default order */
  }
}

/** Apply saved order to a list, with unknown modules appended. */
export function applyNavOrder<T extends { name: string }>(items: T[], order: string[]): T[] {
  if (order.length === 0) return items;
  const pos = new Map<string, number>();
  order.forEach((name, i) => pos.set(name, i));
  return [...items].sort((a, b) => {
    const ai = pos.has(a.name) ? pos.get(a.name)! : Number.MAX_SAFE_INTEGER;
    const bi = pos.has(b.name) ? pos.get(b.name)! : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}
