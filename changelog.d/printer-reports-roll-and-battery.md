---
type: feature
scope: labels
date: 2026-07-26
docs_target: docs/USER_GUIDE.md#Printers
---
Label printers connected as a serial port now report the roll they have loaded and how much battery is left, so you can check before starting a run instead of after wasting labels.

## docs

### What your printer can tell you

Some label printers can sense the roll you have loaded and report it back, along
with their battery level. When a printer supports this, Cobblr uses it in two
places.

**When you connect.** Pick the port and Cobblr asks the printer what it is. If it
answers, the printer is set up from its own reply, with the dialect and the media
size already filled in. There is nothing to type. If it does not answer, you get
the normal form instead.

**Whenever you want to check.** Press **Check** next to a serial printer and it
reports the roll currently loaded and its battery, for example
`40 × 30 mm loaded` and `4/5`.

The roll size is read from the media itself, not from your settings, so it follows
a roll swap. Swap a roll, press Check, and the new size appears without you
changing anything.

Battery is shown as bars rather than a percentage, matching what these printers
display on their own screens. Hovering shows the underlying voltage reading.

**Which printers can do this.** So far this works over a serial connection only.
Printers connected over Bluetooth print normally but stay silent about their
status, so no reading appears for them. Web Serial needs Chrome or Edge on a
desktop computer; phones and tablets cannot use it.
