---
type: feature
scope: inventory
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#3.1 Inventory
docs_published: 2026-10-08
---
Added stock shapes for sheets, rolls, spools, liquids, wearing tools and counted supplies, with job use, replacement reminders and QR loading at a browser station.

## docs

### Workshop stock shapes

Open an Inventory record and use **Workshop stock** to choose Sheet, Roll,
Spool, Liquid, Wearing tool or Count. Set what remains and the low-stock
threshold in that shape's unit. A roll also keeps its width and waste per job.
A spool can keep grams per metre to convert between weight and length.
Low stock offers **Add to list** through the existing shopping flow.

Choose **Record stock use**, enter the amount and a job or use reference, and
pick **Came out good** or **Scrap**. Either result uses the stock. Roll waste is
included once. Enter measured waste to replace the allowance for that job.
A repeated reference never uses stock twice. If the job needs
more than remains, the app warns and keeps the amount unchanged so you can
recount it first. Sheets keep their existing area drawing, cut and offcut rules.

A wearing tool counts hours, uses or distance. Its replacement threshold keeps
one usage schedule in Maintenance, and reaching the threshold raises one service
item. Minutes convert to hours. Usage keeps accumulating after the threshold;
the remaining life stays at zero. A replacement physical tool can start a new
record without losing the old tool's history.

Enter a station name and choose **Confirm loaded stock**, then **Open stock
station**. Use the station from any browser or tablet. Scan a record's existing
QR label to confirm the sheet, roll, spool, bottle or tool in a named slot or
colour position. Loading another record replaces that slot's previous load.
**Unload stock** clears the confirmation. Loading records what is at the
station; it does not grant permission to start a machine.

Cobb and the MCP server read the same remaining amounts and can set, recount
and consume stock through the same actions as the app.
