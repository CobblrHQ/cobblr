---
type: improvement
scope: inventory
date: 2026-07-12
---
The inventory item page got four yarn-driven fixes. Quantity now has inline +/- steppers sitting right next to its unit ("[-] 1 [+] skein"), so a tap adjusts stock with no pop-up. The "Reserve for" search names your own workspace's tables (a yarn and designs workspace reads "search a design, project…") instead of hardcoded generic nouns. And the Yarn table now treats yarn as the consumable it is: it hides the Maintenance log (that section is for machines) and turns on skein-by-skein consumption tracking by default. Existing yarn tables pick up the section changes when the bundle updates.
