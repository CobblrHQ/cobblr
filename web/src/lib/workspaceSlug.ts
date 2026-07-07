// At signup, `slugifyWithSuffix()` (api/src/routes/auth.ts) appends a random
// `-<4hex>` suffix to an org slug purely to guarantee global uniqueness without
// a collision check. It's plumbing — the user should never see it. The full
// slug stays the internal API/tenant key; this strips the suffix for DISPLAY
// (and for the URL handle) so `workshop-2e2d` reads as `workshop` everywhere a
// human looks.

/** Strip the random `-<4hex>` uniqueness suffix from an org slug for display. */
export function displaySlug(slug: string): string {
  return slug.replace(/-[0-9a-f]{4}$/, "");
}

/**
 * Derive a URL-handle suggestion from a display name. Mirrors the server's
 * `slugifyBase` (api/src/routes/auth.ts) minus the random uniqueness suffix, so
 * a suggested handle matches what a rename would actually persist (the server
 * re-`normalizeSlug`s on save, so a clean suggestion passes through unchanged).
 * Returns "" for a name with no slug-able characters (caller decides what to do).
 */
export function slugifyHandle(name: string): string {
  return name
    .toLowerCase()
    // Strip a possessive "'s" entirely so "Alex's Workspace" → "alex-workspace"
    // (matches signup); then drop any remaining apostrophes.
    .replace(/['’]s\b/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
