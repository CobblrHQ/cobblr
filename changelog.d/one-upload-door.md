---
type: improvement
scope: scan
date: 2026-08-10
---
**One upload button for photos and receipts.** Adding a receipt used to be a separate menu item from adding a photo, which meant answering "which kind of upload is this?" before you had even chosen a file. Now a single control on the header row takes both, and the file itself decides: a PDF or spreadsheet is only ever a receipt, so it goes to the line-item parser, while pictures go to the photo pipeline. Importing a previous export stays its own menu item, sitting next to Export where it belongs, because an export file is neither a photo nor a receipt. The scan page also drops its duplicate camera button on desktop, which gives the search box noticeably more room to show what you typed.
