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
