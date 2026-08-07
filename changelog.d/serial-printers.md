---
type: feature
scope: print
date: 2026-07-26
docs_target: docs/USER_GUIDE.md#Print labels over Bluetooth
docs_published: 2026-08-07
---
Label printers that connect as a serial port, including Bluetooth Classic models a browser cannot reach over Bluetooth, can now print from Cobblr.

## docs

**Printers that pair but never print.** Some label printers use an older style of
Bluetooth (Classic) that no web browser can talk to, whatever the pairing screen
suggests. They connect, accept everything, and print nothing.

These appear to your computer as a **serial port** once it has paired them, and
Cobblr can print to them that way. On the Printers page choose **Printer paired
but nothing prints? Connect it as a serial port**, pick the port, then set the
command language and media exactly as for any other printer.

This route needs Chrome or Edge on a desktop computer: phones and tablets cannot
open a serial port from a web page. Everything else about the printer works the
same, because Cobblr sends an identical label either way.
