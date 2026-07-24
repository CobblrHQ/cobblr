---
type: fix
scope: core-scan
date: 2026-07-24
---
**Two fixes for viewing and fetching receipt images.** Picking a web-search photo now works far more often: we fetch it the way a browser does (a real user agent and a matching referrer), so images a site would only serve to a browser stop coming back as "couldn't be used." And "View original" now renders the receipt in place, showing a photo as an image, a PDF inline, and an emailed body as text, instead of downloading a file with no name.
