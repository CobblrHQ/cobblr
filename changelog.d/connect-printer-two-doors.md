---
type: feature
scope: printing
date: 2026-07-28
docs_target: docs/USER_GUIDE.md#Print labels over Bluetooth
---
Connecting a printer now asks one question, whether you want to install a helper app, and finds printers on a bridge for you instead of asking for an address.

## docs

**Connecting a printer.** Cobblr asks one question, and it is not a technical
one: do you want to install something.

**Connect through this browser** is the quickest and installs nothing. Your
browser asks which printer to use and you pick yours. If it is not in the list,
**Look again** checks the other place printers can hide, the ones your computer
has already paired. You are never asked which kind of Bluetooth your printer
uses, because that is not something you should have to know.

**Connect through an edge bridge** uses a small app on your computer that talks
to the printer for you. It reaches printers a browser cannot, keeps printing
when you close the tab, and lets you print from your phone. If a bridge is
already running, Cobblr finds it and lists its printers by name, and you press
**Add**. There is no address or port to type.

Cobblr puts the option that works on your device first. On Safari, Firefox, and
anything on an iPhone or iPad, no browser can reach a label printer directly, so
the browser option is shown greyed out with the reason and the bridge leads
instead. Nothing is hidden from you, and nothing is offered that cannot work.
