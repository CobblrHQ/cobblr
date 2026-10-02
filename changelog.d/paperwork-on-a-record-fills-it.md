---
type: feature
scope: scan
date: 2026-10-02
docs_target: docs/USER_GUIDE.md#3.4 Files (foundational)
---
Drop or paste a bill of sale or a receipt on a record's files and Cobblr reads it onto that record. It files the document, links a purchase, and fills what you paid, when and where you bought it and the fields the paper names, such as a vehicle's VIN, make and model. It never writes over something you typed: where the paper disagrees it says so, with Use it beside the paper's value. Undo takes back what it filled. An inbox card for a bill of sale whose VIN matches a vehicle you already have offers It's this one, which does the same. Parts now have a Photos and files section of their own.

## docs

**A bill of sale or a receipt on a record fills it in.** Drop or paste a PDF, a photo or a text file of a bill of sale or a receipt into a record's Photos and files (a vehicle, an asset, a part), and Cobblr reads it onto that record:

- The document stays on the record as a file.
- A purchase is made for it, with the record as its one item. Fees, tax, title and documentary fees stay on the purchase as charges, never as items.
- Fields the record has empty are filled from the paper: what you paid, when and where you bought it, and whatever else it names that the record has a field for (a vehicle's VIN, make, model, year and mileage). The toast names each field the way your workspace labels it, with **Undo**. Undo takes back only what the paper wrote, and leaves anything you changed since.
- A field you already filled is never overwritten. Where the paper says something different, it is listed under the files: "Bill of sale says Paid $14,300 (you have $14,000)" with **Use it** to take the paper's value, or **Keep mine**.

A file that is not a sale (a manual, a warranty card) is simply kept on the record.

**From the scan inbox.** When you upload a bill of sale to the inbox and its VIN matches a vehicle you already have, the card says "This paperwork is for <vehicle>." with **It's this one**, which does all of the above on that vehicle instead of making a second one.

Cobb and the MCP server reach the same door (`core-scan:attach-paperwork`, or `POST /modules/core-scan/scan/paperwork` with `{file_id, kind, id}`).
