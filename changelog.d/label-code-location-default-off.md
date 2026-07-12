---
type: improvement
scope: labels
date: 2026-07-12
---
**Location labels no longer print the little code in the middle of the QR by default.** A location is unique by its name (there is one "Office"), so a disambiguating code drawn in the center is just noise, unlike a part or machine where "p42" tells apart one of many similar items. Locations now default that center code OFF while everything else keeps it ON, with no setup and no re-print of existing labels. Your own per-kind toggle still wins if you want it a different way.
