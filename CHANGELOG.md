# Changelog

User-facing changes, newest first. Dates are release dates.

## 2026-06-17

### Features
- Backups can now go somewhere automatically. Add a *destination*: a server path / NAS folder, or an S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO), choose a daily or weekly schedule and how many copies to keep, and Cobblr pushes a backup on its own. Or hit Back up now to send one immediately. Credentials are encrypted at rest and never shown back.
- You can now download a blueprint of your workspace's *setup*: the modules, custom fields, wires, shared views and bundles you've configured, with no data, to share or reuse, and a full backup (that setup plus every row and uploaded file) as a single `.zip` to keep wherever you like. Restore a backup into a fresh workspace to bring everything back exactly, with the links between things intact. Find it under Configuration → Backup & blueprints.
- New visual form builder (Configuration → Form builder): pick what you're tracking and drag its fields into the order you want, grouping them under named section headings like "Specs" or "Purchase info". The layout you arrange then shows on every add/edit form for that thing.
- A managed app now has a Settings page: a locked app like "Cobblr for Yarn" hides the whole platform, but you still need to tailor it, so the account menu gains a Settings item (at `/me/app-settings`, inside the lock-down) with a friendly show/hide list of every menu surface. Don't want the Designs table, or want to turn the scanner off? Hide it. Nothing is deleted, hiding a table just takes it off the menu and your items stay, ready to reappear when you show it again.
- The notifications bell can now open as a full-height right sidebar (the same shape as the AI chat) not just the compact dropdown. Toggle between the two from the panel icon in the inbox header, and it remembers whichever you prefer.
- Platform operators can now "View as" a workspace member: a read-only, time-boxed, audited support session that renders their workspace exactly as they see it, with an unmissable banner + full-window border. Editing is off by default and takes a deliberate "Enable editing" toggle; every session is logged and leaves a trace in the workspace's own activity feed.
- Colour swatches in the scan inbox: when a scan parses a colour (e.g. a Polar filament spool → "Royal Blue"), the Source-data box and the "From the label" strip now show a real colour swatch next to the value. Vendors give us the colour *name*, not a hex, so the swatch resolves standard web colour names (Royal Blue → a royal-blue dot); a maker-specific name we can't resolve ("Galaxy Black") just stays as text.

### Improvements
- Updating a bundle from your workspace home no longer makes you open the changelog modal and confirm a second time. When an update is conflict-free, the home strip now offers Update now (it applies right there and the line flips to "Update complete") plus a See details link if you want the changelog. The modal only steps in when an update touches a field you'd customized, then the line reads "Resolve conflict to update".
- The Workspace configuration page now has a search bar at the top. Type any part of a setting's name or description ("tokens", "units", "AI", "printer") and the page filters down to the matching tiles across every section, expanding them automatically, so you no longer have to remember which collapsed group a setting lives under. Clearing the search restores the normal grouped view.
- When we resolve your feedback, the in-app notification and Discord message now lead with what you reported before the fix (matching the email) so the reply has context instead of being a wall of fix text. The Discord message keeps a greeting; the in-app bell drops it to stay short.
- Modal and dialog titles now display in their natural case (e.g. "Send feedback", "New order", "Members") instead of being force-lowercased, so they read like proper titles.
