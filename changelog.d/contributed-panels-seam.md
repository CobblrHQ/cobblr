---
type: improvement
scope: platform
date: 2026-07-10
docs_target: none (contributor-facing: documented in machines-digifab-unification.md §5, the authoring-a-module skill, and the panel registry's own comments)
---
**Modules now contribute UI into each other's pages through a declared seam, not a hardcoded import.** A module that operates on another (like the Print Manager operating on your machines) declares its panels in its manifest, and the Fleet tab on 3D Printers and the Print manager panel on a machine now arrive that way, rendered generically by the host page. Nothing changes on screen; what changes is that the next module pair can't grow the old scar. A manifest gate rejects a panel targeting a module the contributor doesn't declare it operates on, and a new lint blocks any page importing another page's internals (the fleet components moved out of the 5,700-line Digital Fabrication page into their own home along the way).
