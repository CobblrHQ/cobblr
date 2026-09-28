---
type: feature
scope: import
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#Bring your spreadsheet
---
Bring your spreadsheet: drop an Excel, LibreOffice or CSV file, or paste a Google Sheets link, and Cobblr shows exactly where every tab, column and row would go before it changes anything. Adjust what you like, import it in one go, and undo the whole import if it is not what you wanted.

## docs

Already keeping a list somewhere? Bring it. Open **Bring your spreadsheet** from the dashboard, the command menu (Ctrl or Cmd plus K), Scan, or Settings, Integrations. Drop a file (`.xlsx`, `.xls`, `.ods`, `.csv` or `.tsv`) or paste a Google Sheets link. A Google Sheet needs its sharing set to anyone with the link can view.

Cobblr reads every tab and works out what it holds. It finds the header row even under a title and a blank line, joins a heading that spans several columns onto the columns under it, and understands prices, dates, yes or no columns, barcodes and ISBNs (checked), amounts like 500 g, and short lists of choices. A heading on a row of its own, like Fridge above the things kept in it, becomes where those things are kept. Totals, titles and blank lines are left out, and it tells you which rows and why.

**Nothing changes until you press Import.** For each tab you see:

- **Where it goes.** A collection you already have, one to add (a printer list goes to 3D Printers, a book list to Bookshelf, a pantry list to Groceries), or a new collection named after the tab. Pick another from the list if you want, or rename the new one.
- **Every column, and where it goes.** The name, how many, where it is kept, its category, tags, a photo, a field the collection already has, or a new field made from the column. Nothing is dropped without you choosing it. A value that does not fit its field is kept as you wrote it.
- **What each row becomes.** New, an update to something you already have (with what changes), or already there. Leave out any row you do not want.

Import runs in the background and shows its progress; you can close the sheet while it works. Importing the same file again updates what changed and adds what is new, matched by the key column (an SKU, a barcode, an ISBN or a serial), and never makes a second copy.

**Undo takes the whole import back.** It removes what the import added, puts back exactly what it changed, and removes the collection, fields, places and categories it made. If you changed something after the import, undo leaves that alone and tells you, and **Undo those too** takes it anyway. Your past imports are listed at the bottom of the sheet, each with its own undo.

Adding a collection, adding fields or making a new collection is for owners and admins, the same as doing those by hand. A member can import into a collection that already has the fields.
