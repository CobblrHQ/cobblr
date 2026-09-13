---
type: feature
scope: navigation
date: 2026-09-13
docs_target: docs/USER_GUIDE.md#Top nav
---

The Scan Inbox row now shows how many captures are waiting to be filed, in the sidebar, the top bar and the phone menu, and the full-sidebar foot puts Scan first on its own row with your account last.

## docs

**The Scan Inbox row carries a count.** Scan a few things on your phone, sit down at a desk, and the Scan Inbox row in the navigation says how many are waiting to be filed: the same number the inbox page shows at the top. It appears in the left sidebar, on the top-bar chip (and on **more ▾** when the row is folded into it) and in the phone menu, refreshes every few seconds, and disappears at zero. The camera button itself stays a plain button, since it opens the scanner rather than the inbox.

**The full-sidebar foot reads top to bottom as tools, then you.** Scan is the first row under the navigation, on a full row of its own, with Build under it; then Search, Notifications, the label queue, the Live box and Ask Cobb. Under a rule come Feedback, Configuration, Your account and your name, which opens the compact account menu.

A module can declare a count for its own nav row in its manifest (`nav.count`); see the manifest contract in the architecture docs.
