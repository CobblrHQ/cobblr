---
type: fix
scope: platform
date: 2026-07-14
---
Fixed: the New asset and New machine forms, and the asset and machine list columns, ignored a bundle's rename of the manufacturer field. Install Vehicles, which renames it to Make, and those surfaces still said Manufacturer while the detail page said Make. They now read the name from the same place every other form does, so a rename reaches every surface at once.
