---
type: feature
scope: sales
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#3.26 Sales (outbound orders)
docs_published: 2026-10-01
---
A sales order can now put what it needs in to be made: "Make this" on a line plans a work order in Builds for that order, the line shows how many are made (only parts that came out good count, and the oldest order is filled first), the work order closes itself when enough are made, and the order ships what exists.

## docs

**Making what an order needs.** On a sales order, a line for a part you make has **Make this**: say how many, and a work order goes on the Builds production schedule, marked with the order it is for. When Fulfill finds too few in stock, its **Make N more** does the same in one tap. The line then shows how many are made: only parts that came off a print or a hand-logged run **good** count, a failed or scrapped print counts nothing, and when two orders need the same part the older one is filled first, so they never both count the same pieces. A work order closes by itself once it has enough, and the order ships from what is in stock. With Digital Fabrication on, the line also links to the **Make** started for it, whose page says which order it is for. If nothing is set up to make that part yet, the order says so and takes you to Builds to add one.
