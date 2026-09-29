---
type: feature
scope: import
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#Bring your spreadsheet
---
Bring your spreadsheet: drop an Excel, LibreOffice or CSV file, or paste a Google Sheets link, and Cobblr shows exactly where every tab, column and row would go before it changes anything. Adjust what you like, import it in one go, and undo the whole import if it is not what you wanted.

## docs

Already keeping a list somewhere? Bring it. Open **Bring your spreadsheet** from the dashboard, the command menu (Ctrl or Cmd plus K), Scan, or Settings, Integrations. Drop a file (`.xlsx`, `.xls`, `.ods`, `.csv` or `.tsv`) or paste a Google Sheets link. A Google Sheet needs its sharing set to anyone with the link can view.

Cobblr reads every tab and works out what it holds. It finds the header row even under a title and a blank line, joins a heading that spans several columns onto the columns under it, and understands prices, dates, yes or no columns, barcodes and ISBNs (checked), amounts like 500 g, and short lists of choices. A heading on a row of its own, like Fridge above the things kept in it, becomes where those things are kept. Titles and blank lines are left out, and it tells you which rows and why. A list kept by adding to the top, with its header row under the data, is read the same way: every row above the header comes in. A sheet saved without a header row keeps every row, and its columns are named from what they hold; where the values do not say, and AI is set up, the first few rows are used to name them.

**Nothing changes until you press Import.** For each tab you see:

- **Where it goes.** A collection you already have, one to add (a printer list goes to 3D Printers, a book list to Bookshelf, a pantry list to Groceries), or a new collection named after the tab. Pick another from the list if you want, or rename the new one.
- **Every column, and where it goes.** The name, how many, where it is kept, its category, tags, a photo, a field the collection already has, or a new field made from the column. Nothing is dropped without you choosing it. A value that does not fit its field is kept as you wrote it.
- **What each row becomes.** New, an update to something you already have (with what changes), or already there. Leave out any row you do not want.

**Your sheet's own totals are checked, not imported.** Rows like Price Totals, Average Cost or Total Still Owned stay out of your things, and the dry run checks each one against what is being imported: "Price Totals $4,873.00, the import agrees" or, if you left rows out, what the import comes to instead. An average is checked over the rows your sheet divided by (all of them, or the ones with a date). The totals stay with the import, so you can see them again under your past imports.

**What became of things.** A column like Fate, where you wrote Sold for $100, Parted out, Given to a friend or Turned into something else, is read as what happened to each thing, and a blank means you still have it. The dry run counts them ("55 still yours, 11 no longer: parted out 5, given away 3, sold 2, converted 1"), and **Import only what you still have** leaves the rest out. The ones that come in are marked as no longer yours where the collection can say so (a 3D printer's state becomes sold, given away, parted out or converted, and an inventory item is archived), so nothing reminds you to maintain a printer you sold. The words you wrote are kept, and a price in them is kept as Sold for.

**Prices.** Free is a price of nothing, and Free in Trade is kept as written beside the 0. A price column goes to Paid, when it became yours to Acquired on, the same fields a receipt fills; with fees or shipping in a column of their own, both are kept and Paid holds them together.

**Identical rows.** Several rows that are the same in every column, like four of one printer bought the same day at the same price, come in as one record of four where the collection keeps a count. **Keep identical rows as a record each** brings them in one by one instead.

**Pictures.** A column of picture links becomes each thing's picture: Cobblr fetches the picture and keeps it in your files, so it stays even if the link goes away. A watermarked stock-agency preview is never used, and the dry run says which rows that leaves out. Things that arrive without a picture are offered one later, a few at a time, the same as anything you add another way. A picture you set yourself is never replaced by a re-import.

Import runs in the background and shows its progress; you can close the sheet while it works. Importing the same file again updates what changed and adds what is new, matched by the key column (an SKU, a barcode, an ISBN or a serial), or by name, or by name and date when names repeat, and never makes a second copy.

**Undo takes the whole import back.** It removes what the import added, puts back exactly what it changed, and removes the collection, fields, places and categories it made. If you changed something after the import, undo leaves that alone and tells you, and **Undo those too** takes it anyway. Your past imports are listed at the bottom of the sheet, each with its own undo.

Adding a collection, adding fields or making a new collection is for owners and admins, the same as doing those by hand. A member can import into a collection that already has the fields.
