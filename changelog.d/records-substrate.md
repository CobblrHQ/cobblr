---
type: feature
scope: platform
date: 2026-07-18
docs_target: none (docs shipped directly in this PR: USER_GUIDE 3.27)
---
A new Records module gives catalog-like collections a lean home of their own. A record carries only a name, photo, location, notes, and the fields you declare, so a Bookshelf or a Movies list no longer has to ride on the assets module and inherit State, Warranty, and Serial number. Each collection is its own named instance with its own page, fields, and views, and the detail opens in the wide photo-left layout. An operator can re-home an existing assets-based collection in one call: ids are preserved so labels and links keep working, attachments and tags follow, and any real value in a borrowed field folds into the record itself rather than being lost.
