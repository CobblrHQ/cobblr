---
type: feature
scope: labels
date: 2026-10-04
docs_target: docs/USER_GUIDE.md#3.2 Labels
---
Added NFC tags for record labels, with Android writing, bulk writing from Labels, tap scanning and a tag-link copy option for other phones.

## docs

**NFC tags.** Beside a record’s **Print label** button, choose **Write to NFC tag**
in Android Chrome. Hold a writable NFC sticker near your phone until the write
finishes. The tag carries the same link as the QR label, so moving or renaming
the record keeps the tag usable. Any phone that reads URL tags can open it.

For several tags, add the records to the **Labels** queue, set the copies you
need, then choose **Write to NFC tag**. The writer shows the record and progress
for each copy. Remove the finished tag, press **Write to NFC tag** again, and tap
the next tag. A failed write stays on the same record so you can try again.
**Cancel write**, or closing the writer, stops a pending write. Writing tags
leaves your print queue intact.

Elsewhere, choose **Copy tag link**. Paste it into any NFC writer app (for
example NFC Tools) to write the tag. For a queue, copy each link, write it in the
other app, then press **Next tag**. Use Android Chrome to write tags directly;
any phone can read them. On iPhone, sign in to Cobblr in Safari once and tags
open straight to the record.

In Android Chrome, **Tap a tag** beside the camera scanner listens for a label
tag and handles it just like a camera scan, including the active place. Use
**Cancel tag scan** to stop listening. For an optional iPhone shortcut, create
an NFC personal automation in Shortcuts that opens Cobblr’s scan page with
your place active.
