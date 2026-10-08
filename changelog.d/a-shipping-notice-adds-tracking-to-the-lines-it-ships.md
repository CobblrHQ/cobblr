---
type: feature
scope: purchases
date: 2026-10-08
docs_target: docs/USER_GUIDE.md#Tracking a parcel
---
A forwarded shipping notice for an order you already imported now adds its tracking number to that order instead of answering "you already imported this receipt". When a store ships an order in several boxes, each notice's number goes on the lines in that box, the rest show "Not shipped yet", and each box is followed and confirmed on its own. Amazon Logistics numbers (TBA…) are now followed too, for free, with nothing to set up.

## docs

**Forwarding a shipping notice.** Forward a store's "your order is on the way" email to your receipt address, and Cobblr adds its tracking number to the order it belongs to. The reply says what it did: "Tracking added to order #36772 (Kingroon 3D): PETG Multicolor, Amazon Logistics TBA335321582286, expected Oct 11." It works whether the notice arrives before or after the receipt, and when you forward it from your own mailbox, where the store's name is only in the forwarded header.

**A receipt filed as arrived that was still on its way.** A receipt with no tracking number and no delivery date is recorded as arrived, its items added to stock, because most receipts are for things already in your hands. When a shipping notice for that order comes in afterwards, it proves otherwise: the order goes back to being on its way and the items come off your stock until the box turns up. Their cost is still counted once. An arrival you confirmed yourself is never undone.

**An order that ships in more than one box.** Some stores ship each part of an order separately and send a notice per box, listing what is in it. Each box becomes a parcel of the order with its own tracking number. On the order, a line says which parcel it is in ("On its way · TBA335321582286"), and a line no notice has named yet says **Not shipped yet**. Each parcel is followed on its own number, and when one is delivered you are asked about that box alone: "Yes, it turned up" receives just its lines. The order counts as arrived once every line has. You can also add a parcel yourself from the order's actions with **Add a parcel**.

**Amazon Logistics.** Parcels with an Amazon Logistics number (TBA followed by twelve digits) are followed through Amazon's public tracking page, with no account or key. Cobblr asks a few times a day, more on the delivery day. If Amazon asks it to slow down, it keeps the last thing it knew and tries again later.
