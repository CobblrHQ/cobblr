---
type: fix
scope: platform
date: 2026-08-22
---
Buttons that only appeared when you hovered now exist on a phone. Twenty controls - the delete button on every row of Lists, Builds, Sales and Tracking, the delete on an attachment or a file, the actions on a project task - were drawn fully transparent and only faded in on hover, which a touch screen never does, so on a phone they were not dimmed but absent. They are visible by default now and still fade in on a desktop, where hovering is what reveals them, and they appear on keyboard focus too. The selection bar also says just the number on a phone rather than "2 selected", and its close button is pinned so it can never be pushed off the edge by a long row of actions.
