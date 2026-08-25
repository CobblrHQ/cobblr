---
type: fix
scope: scan
date: 2026-08-25
---
The scan inbox now tells the truth when something goes wrong: a failed load shows a retry instead of pretending the inbox is empty, batch filing reports why lines failed instead of a green "0 confirmed", long batches show "Filing 12 of 40" progress, and a rename that could not save says so. On phones the session row scrolls so Location and File all are always reachable, the parcel panel stays on screen, and a workspace with no locations files directly instead of opening an empty picker.
