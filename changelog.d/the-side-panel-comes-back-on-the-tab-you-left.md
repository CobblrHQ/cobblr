---
type: fix
scope: navigation
date: 2026-08-24
---
Refreshing while the side panel is open now brings it back on the tab you were using, rather than dropping you on Ask Cobb. It already remembered that the panel was open and which page you opened it on; it just never remembered which tab was showing, so a reload in the middle of a discussion handed you the assistant instead. As before, the panel only returns on the page you opened it on, and only for as long as the browser tab is alive.
