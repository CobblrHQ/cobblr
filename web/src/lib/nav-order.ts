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

// ── per-device hidden nav entries (the "enable flag") ────────────────
// A user hides nav entries they don't want cluttering their header
// (e.g. dev/sample modules) without disabling the module. Per-device
// like nav-order — a personal preference, not an org-wide edit. Layers
// on top of the org-wide `entity_kind_overrides.hidden` an admin can set.
const HKEY = (slug: string) => `cobblr:nav-hidden:${slug}`;

export function readNavHidden(slug: string): string[] {
  if (!slug) return [];
  try {
    const raw = localStorage.getItem(HKEY(slug));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeNavHidden(slug: string, hidden: string[]) {
  if (!slug) return;
  try {
    localStorage.setItem(HKEY(slug), JSON.stringify(hidden));
    window.dispatchEvent(
      new CustomEvent("cobblr:nav-order-changed", { detail: { slug } }),
    );
  } catch {
    /* quota or disabled — silently keep all visible */
  }
}

export function toggleNavHidden(slug: string, name: string) {
  const cur = readNavHidden(slug);
  writeNavHidden(
    slug,
    cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name],
  );
}

// ── per-device "always in More" nav entries ─────────────────────────
// A user pins entries to the "more ▾" overflow so they never sit in the
// row even when there's space — keeping the bar to the few they use most.
// Distinct from hidden (still reachable, just folded) and per-device like
// the rest of these prefs. The responsive overflow folds the REST as the
// window narrows; these are folded unconditionally.
const OKEY = (slug: string) => `cobblr:nav-overflow:${slug}`;

/** Folded into "more ▾" BY DEFAULT, until the user first customizes the set.
 *  These are always-on companions that are rarely the destination — the bar
 *  (and the dashboard's Jump-to tiles) should lead with the workhorses:
 *  Inventory, Machines, Locations, the named instances. The user's first
 *  toggle REPLACES the default wholesale (toggleNavOverflow reads-then-writes
 *  the full list), so un-folding any of these sticks. */
export const DEFAULT_NAV_OVERFLOW = ["lists", "projects", "purchases"];

export function readNavOverflow(slug: string): string[] {
  if (!slug) return [];
  try {
    const raw = localStorage.getItem(OKEY(slug));
    if (raw == null) return [...DEFAULT_NAV_OVERFLOW];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function writeNavOverflow(slug: string, names: string[]) {
  if (!slug) return;
  try {
    localStorage.setItem(OKEY(slug), JSON.stringify(names));
    window.dispatchEvent(new CustomEvent("cobblr:nav-order-changed", { detail: { slug } }));
  } catch {
    /* quota or disabled — keep everything in the row */
  }
}

export function toggleNavOverflow(slug: string, name: string) {
  const cur = readNavOverflow(slug);
  writeNavOverflow(slug, cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]);
}

// ── per-device hidden header quick-actions (the right-cluster icons) ──
// Separate from nav-hidden so a module that contributes BOTH a left-nav
// entry and a right-cluster icon can have each toggled independently.
// Keyed by module name (a module contributes at most one header action).
const AKEY = (slug: string) => `cobblr:nav-actions-hidden:${slug}`;

export function readNavActionsHidden(slug: string): string[] {
  if (!slug) return [];
  try {
    const raw = localStorage.getItem(AKEY(slug));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function toggleNavActionHidden(slug: string, name: string) {
  const cur = readNavActionsHidden(slug);
  const next = cur.includes(name)
    ? cur.filter((n) => n !== name)
    : [...cur, name];
  try {
    localStorage.setItem(AKEY(slug), JSON.stringify(next));
    window.dispatchEvent(
      new CustomEvent("cobblr:nav-order-changed", { detail: { slug } }),
    );
  } catch {
    /* quota or disabled — keep all visible */
  }
}

/** Move `name` one slot up (dir=-1) or down (dir=+1) within `names`,
 *  returning the new order. Powers the navbar customize control's
 *  reorder arrows. */
export function moveInOrder(names: string[], name: string, dir: -1 | 1): string[] {
  const i = names.indexOf(name);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= names.length) return names;
  const next = [...names];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
