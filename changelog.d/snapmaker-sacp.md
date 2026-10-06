---
type: feature
scope: digifab
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#3.19 Digital Fabrication (`digifab`, stock)
---
Added touchscreen pairing and reviewed print starts for Snapmaker SACP firmware on 2.0, J1 and Artisan.

## docs

Choose Snapmaker (2.0, J1, Artisan) in bridge setup. Use Find Snapmakers or enter the printer's address. The bridge selects HTTP or SACP firmware automatically. Press Pair Snapmaker and approve on the printer's touchscreen. Cobblr saves the approved token privately and releases the display after each operation.

Queue a sliced G-code file and open its Machine station beside the printer. Authorize the screen, check the bed and installed printing head, then choose Review print and Start print. The exact reviewed file and printing head must still match. Laser, CNC and unknown heads are refused. Stop remains available without screen authorization, and the bed remains occupied until machine status confirms it has stopped.
