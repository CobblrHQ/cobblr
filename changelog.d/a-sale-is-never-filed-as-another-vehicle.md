---
type: fix
scope: core-scan
date: 2026-10-12
docs_target: none (documented directly in docs/modules/core-scan.md)
---
A bill of sale can no longer be filed as the wrong vehicle. A VIN now counts only when its check digit is right; when the VIN on the page won't read, Cobblr asks you to type it instead of naming the car from the year and model printed beside it, and nothing is filed until you do. A car found only by its year, make and model, with no VIN read, is offered as a question ("Is this your Civic? Matched by name; the VIN didn't read; check it's this car"), and nothing is filled until you say it is. If the page reader stops partway, you're told so and can read the page again; it's never treated as a blank page.
