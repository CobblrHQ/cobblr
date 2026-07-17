---
type: improvement
scope: core-scan
date: 2026-07-17
---
**A scan session now has a real "File all" button, so a finished session is one tap from filed.** Once the AI finishes a scan session, its header used to show a passive "✓ All set" check. Clicking it only collapsed the row, so it was easy to think a whole session had been filed when in fact nothing was committed, the items just sat in the inbox. That check is now a **"File all N"** button. Tapping it commits every ready item in the session to the exact destination the AI matched it to (each book to your Bookshelf, a VIN to Vehicles, and so on), not one lumped table. Items that still need a manual look are left behind and the header says "needs review"; a fully filed session reads "✓ filed". A bulk confirm that carried the item to a named table (like a Bookshelf) was also being sent with the wrong routing and would fail, that is fixed in the same change.
