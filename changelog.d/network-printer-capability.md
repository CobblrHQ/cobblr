---
type: feature
scope: printing
date: 2026-07-22
docs_target: docs/USER_GUIDE.md#Printers
---
Network printers now declare their type (inkjet/laser or thermal) and widest media, so the label size pickers only offer sizes that printer can actually run.

## docs

When you add a network printer (a CUPS manager or an edge bridge), pick its type and set the widest media it can feed. Cobblr uses that to funnel the label sizes it offers you: an inkjet or laser printer only sees sheet layouts, a thermal roll printer sees rolls, and nothing wider than the printer is ever listed. Bluetooth label printers fill this in automatically from the model they detect, so you only set it by hand for a network printer.
