---
type: improvement
scope: digifab
date: 2026-07-11
docs_target: none (docs updated in-place this PR: USER_GUIDE.md "Machine links." under 3.19 Digital Fabrication)
---
**Jump from a printer's controls to its full record.** The cockpit (the camera/controls modal a fleet tile opens) now has an **Open machine** link in its header that takes you straight to that printer's machine record, on its own collection page, with the detail open. Together with last change's Open controls button, you can now round-trip freely between operating a machine and editing its specs, mods, and notes, from either side. Under the hood, machines in a named collection (3D Printers, Laser Cutters) are now correctly deep-linkable, which also fixes cross-app links that used to point every machine at the default Machines page.
