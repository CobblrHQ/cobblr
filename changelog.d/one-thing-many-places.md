---
type: feature
scope: inventory
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#3.1 Inventory
---
The same thing kept in several places is now one item with a row per place. Gauze pads in a supply closet and in five ambulances read as one card: the total, how many places, and a row for each place with its own count, its own minimum and its own low warning, so one short ambulance shows even when the closet is full. Add a place from the item's page, split a place back into its own record, or switch the list to one line per place. Restock one place from another and the soonest-expiring lot goes first, keeping its expiry date and lot number, and deliveries can be entered with the date and lot printed on them. A location's page shows what it carries and what is short, with a minus and plus on each line for that place, and a Going off list shows every lot about to expire, place by place. Records that were entered once per place are offered as one item (never combined without a yes), and scanning something kept in several places asks which place it is for.

## docs

**One thing kept in several places.** When the same thing lives in more than one
place (a supply in a closet and in each vehicle, spare parts in two workshops),
keep it as one item with a row per place.

On the item's page, **Where it's kept** lists every place. Each row has its own
count with **-** and **+**, its own minimum, and its own **low** warning, so a
vehicle that is short says so even when the closet holds plenty. **+ Keep it
somewhere else too** adds a place: pick it, say how many are there and the
minimum you keep there.

In the list the item is one card. Its top line says how many there are in all,
in how many places, where it is low, and when the soonest stock expires, and a
row for each place sits underneath. **By item / By place**, beside the list and
tiles switch, turns the list into one line per place when you want the
spreadsheet view.

**Lots, and restocking one place from another.** Each place keeps its stock in
lots: how many, when they arrived, the expiry printed on them, and the lot
number. **Stock arrived** on a place records a delivery with its printed date
and lot number. **Restock from…** moves stock to that place from another place
of the same item: the lot that expires soonest goes first unless you pick one,
and every lot keeps its expiry and lot number, so a vehicle restocked from the
closet is warned about exactly the bags it received. Both places record the
move in their history. **Show N lots** lists a place's lots, and using one
always takes the soonest-expiring lot there.

**What a place carries, and what is going off.** A location's page shows
**Stock here**: everything kept there or inside it, from every list, with the
count against the minimum kept there, what is low, and when the soonest of each
goes off. Each line has a **−** and **+** that change the count at that place
only, so scanning a shelf's label and tapping **−** takes one off that shelf. **Going off**, a tab on the inventory pages whenever something is
dated, lists every lot about to expire within 7, 30 or 90 days, anything past
its date first, grouped by place with the most urgent place on top.

The name, photo and category belong to the item, so changing them on any row
changes them everywhere. **Split into its own** turns one place's stock into a
record of its own, keeping its count and history. Deleting the item never
deletes the stock at its other places: each becomes a record of its own.

**Records entered once per place.** When two records look like one thing kept
in two places (the same name or the same barcode, at different places), the
list says so and offers **Combine**, which makes them one item with a row per
place. **They're different** stops the question for good. Nothing is ever
combined without that tap.

**Scanning something kept in several places** asks which place it is for, then
**+1 more** adds there and the choice is remembered. A scan made while working
in one place goes to that place without asking.
