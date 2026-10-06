---
type: selfhost
scope: docker
date: 2026-10-05
---
The API image is much smaller: 624 MB instead of 1.18 GB, and a pull moves 149 MB instead of 242 MB. It carries only the packages the server actually loads, not the web app's libraries and build tools. An update from the previous image keeps your data and modules as they were, and CI now checks that on every build.
