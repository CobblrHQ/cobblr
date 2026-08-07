---
type: feature
scope: bundles
date: 2026-07-12
docs_target: docs/USER_GUIDE.md#4.4 Bundles (publishable presets)
docs_published: 2026-08-07
---
Bundle updates now apply by their version number instead of nagging you for every change. Small fixes (patch releases) apply themselves quietly in the background. Feature releases (minor versions) apply themselves too and show a toast telling you what was added. Big releases (major versions) still ask first, so you review and confirm exactly as before. Anything that would collide with a field you customised keeps prompting, so nothing you changed is overwritten silently.

## docs

Installed bundles surface an "update available" nudge on your dashboard when the catalog has a newer version. How that update applies now depends on the version bump (semantic versioning):

- **Patch releases (e.g. 1.2.3 to 1.2.4):** small fixes. These apply automatically and silently, with no toast or interruption. Each auto-applied update is recorded in the workspace Activity log, so there's always an audit trail of what changed and when.
- **Minor releases (e.g. 1.2.0 to 1.3.0):** new, backward-compatible additions. These apply automatically and show a toast naming what was added (new fields, new automations).
- **Major releases (e.g. 1.x to 2.0.0):** potentially breaking changes. These are never silent. You get the explicit "Update now / See details" prompt and confirm the update yourself, as before.

Auto-apply only ever runs when the update is safe for your workspace. If the new version changes or removes a field you customised (an "upgrade conflict"), or needs a module you haven't enabled, the update falls back to the manual prompt so you can resolve it on your terms. Bundles that ship reference catalogs also always prompt, so an update never silently drops rows you imported into a catalog. Only workspace owners and admins auto-apply updates; guests are never affected. Non-standard or pre-release version numbers always prompt rather than apply silently.
