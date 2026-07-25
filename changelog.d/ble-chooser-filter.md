---
type: feature
scope: print
date: 2026-07-25
docs_target: docs/USER_GUIDE.md#Print labels over Bluetooth
---
Pairing a Bluetooth label printer now lists printers instead of every Bluetooth device in range, with a fallback for printers that do not announce themselves.

## docs

**Pairing a Bluetooth printer.** The device chooser now shows label printers
rather than everything Bluetooth within range, so you are not hunting for your
printer among headphones, phones and TVs. Cobblr matches on the services a
printer advertises and on known model names.

Some inexpensive printers announce neither, and would not appear in a filtered
list. If yours is missing, use **Don't see your printer? Show all Bluetooth
devices** under the Bluetooth option on the Printers page to pick from the full
list as before.

One caution worth knowing: pairing succeeding does not by itself mean Cobblr can
drive the printer. If a model is not one Cobblr recognises, it will connect and
then print nothing, because its command language is specific to its own app. If
that happens, the printer is not supported yet rather than broken.
