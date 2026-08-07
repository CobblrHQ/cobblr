---
type: feature
scope: configuration
date: 2026-07-30
docs_target: docs/USER_GUIDE.md#Top nav
docs_published: 2026-08-07
---

Configuration is five sections instead of 34 tiles. The hub opens to a card per
section (Workspace, Build, People, Connections, System, plus Cloud on a hosted
instance), nothing hides behind "Show advanced settings" any more, and you only
see settings whose module is switched on and that your role can use.

## docs

`/configuration` used to be a wall of 34 tiles: 11 visible and 23 behind a
**Show advanced settings** button, with two whole groups that did not appear at
all until you found it. It is now five cards, one per section, each listing its
settings so you can click straight through:

| Section | What you go there to do |
|---|---|
| **Workspace** | Change how this workspace reads: General (simple mode), Presentation, Units, Templates, Backup & blueprints |
| **Build** | Compose what it is made of: Modules, Bundles, Wires, Actions, Fields & forms, Apps, plus a **+ New thing** button |
| **People** | Decide who gets in: Members & invites, Permissions, Member portal |
| **Connections** | Reach something outside it: AI, Assistant, Integrations, Scan rules, Devices, Workspace links, Public surfaces, API tokens |
| **System** | Check on it: Activity log, Background queue, Healthcheck, OpenAPI |

On a hosted Cobblr a sixth **Cloud** card holds your plan and the connectors we
manage for you. A self-hosted instance never shows it.

**You only see what applies.** A setting whose module is switched off is no
longer listed, so no tile leads to a page that cannot work. Settings your role
cannot use stay out of your way too.

**Three pages gather what used to be scattered.** **Fields & forms** lets you
define a field and place it on the form in one screen, rather than finishing on
one page and hunting for another. **Permissions** holds grants, custom roles and
accounts, which were three separate addresses reachable only through a tab
strip. **Devices** holds bridges, machine managers and printers, which were
three entries in the group you could not see on arrival.

**Search still beats browsing when you know the name.** The search bar matches
on synonyms, so "roles" finds Permissions, "swagger" finds OpenAPI and
"octoprint" finds Devices. Inside a settings page the sidebar lists everything
by section with your page highlighted; on a phone it becomes a **Jump to…**
picker, so you can move between settings without returning to the hub.

**Things you browse are not settings.** Locations, Files, Tags, Saved views and
the Maintenance log are lists you look at, so they moved to the workspace nav
and each has one address. Old links redirect.

Your profile is now **Your account**, to match: Configuration means the
workspace, Your account means you.
