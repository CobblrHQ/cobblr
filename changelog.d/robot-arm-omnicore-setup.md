---
type: feature
scope: digifab
date: 2026-10-17
docs_target: docs/user-guide/digifab.md#3.19 Digital Fabrication (`digifab`, stock)
---

ABB OmniCore arms connect over Robot Web Services 2.0, with the controller's certificate pinned.

## docs

Bridge setup offers **Robot arm: ABB OmniCore (Robot Web Services 2.0)** for an OmniCore controller on RobotWare 7. Give the controller's address, the SHA-256 fingerprint of its certificate, an RWS user allowed to load and run programs and its password (entered masked), plus the same optional program folder, cycle and cycle counter as an IRC5. To find the fingerprint, open the controller's address in a browser on the shop network, view its certificate and copy the SHA-256 fingerprint. The bridge checks the certificate against it before it sends anything, so the password only ever goes to that controller. If the certificate changes, the arm reads offline until you check and enter the new fingerprint. Loading, starting, stopping and the write lock work as on an IRC5.
