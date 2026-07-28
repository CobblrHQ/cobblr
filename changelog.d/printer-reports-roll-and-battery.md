---
type: feature
scope: labels
date: 2026-07-26
docs_target: docs/USER_GUIDE.md#Printers
---
Label printers now report the roll they have loaded and how much battery is left, so you can check before starting a run instead of after wasting labels. Printers connected through an edge bridge are asked automatically, and the Labels page sets the media to the roll they report.

## docs

### What your printer can tell you

Some label printers can sense the roll you have loaded and report it back, along
with their battery level. When a printer supports this, Cobblr uses it in three
places.

**When you connect.** Pick the port and Cobblr asks the printer what it is. If it
answers, the printer is set up from its own reply, with the dialect and the media
size already filled in. There is nothing to type. If it does not answer, you get
the normal form instead.

**When you pick it on the Labels page.** A printer connected through an edge
bridge is asked as soon as you select it, with nothing to press. If it reports a
coded roll, the Media and Label pickers move to that roll for you, and the roll
size and battery appear beside them, for example `40 × 30 mm · battery 4/5`.

**Whenever you want to check.** Press **Check** next to a serial printer and it
reports the roll currently loaded and its battery.

The roll size is read from the media itself, not from your settings, so it follows
a roll swap. Swap a roll, reload the Labels page, and the new size appears
without you changing anything.

The reading is taken once per printer per visit rather than continuously.
Asking costs a real connection to the printer, and on a Bluetooth Classic
printer only one program can hold that connection at a time, so a reading on
every screen refresh would take the link you are about to print with.

Battery is shown as bars rather than a percentage, matching what these printers
display on their own screens.

**Which printers can do this.** It works over a serial connection and through an
edge bridge. Printers driven over Bluetooth from the browser print normally but
stay silent about their status, so no reading appears for them. Web Serial needs
Chrome or Edge on a desktop computer; phones and tablets cannot use it, which is
one of the things an edge bridge is for.

Plain roll stock carries no size code. On an uncoded roll many printers report a
battery level and nothing about the media, and some report nothing at all. That
is normal rather than a fault: when there is no reading, the pickers stay where
you left them and you choose the size yourself.
