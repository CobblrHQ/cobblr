---
type: feature
scope: print
date: 2026-07-26
docs_target: docs/USER_GUIDE.md#Print labels over Bluetooth
docs_published: 2026-08-07
---
Two printers of the same model are now told apart, so a job cannot print on the wrong machine, and network label prints get the same edge protection against paper drift as Bluetooth ones.

## docs

**Two printers of the same model.** If you have two of the same printer, Cobblr now
remembers which physical machine each one is, so a job cannot come out on the wrong
one. It learns this the first time you pair or print, from the printer you pick in
the browser's device list.

That memory belongs to the browser you set it up in, because Bluetooth deliberately
does not expose a permanent hardware serial. On a different computer Cobblr will
ask you to pick the printer once more, then remembers it there too. If the printer
it expects is switched off or out of range, it asks rather than quietly using the
other one.

**Edge protection on network prints.** Labels sent to a network or system printer
now keep the same wider left and right margins as Bluetooth prints, so a roll that
drifts sideways in the feed path does not clip the edge of a label.
