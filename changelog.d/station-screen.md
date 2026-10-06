---
type: feature
scope: scan
date: 2026-10-06
docs_target: docs/USER_GUIDE.md#1.2 Scanning, the spine
---
A tablet and a barcode scanner can be a station of their own: scan something and it shows what it is, with +1, Used one, Set total and Move to, or the scan inbox's card for something new.

## docs

A station is a page for a tablet with a barcode scanner, for a pantry shelf, a "used up" bin or a workbench. Each one has its own address, such as `/station/home/pantry`.

**Set one up.** Open Configuration → Devices → Stations, type an address (lowercase words and dashes), and open its link on the tablet; the QR on that page opens it for you. The tablet shows a six-character code. Approve it from your phone or computer: scan the tablet's QR, or type the code under Devices → Stations. After that the tablet opens straight to the station every time, with nobody signed in on it. Plug in or pair a USB or Bluetooth scanner in keyboard mode, and add the page to the tablet's home screen to keep it one tap away. The screen stays on while the station is open.

**Scan.** Something you already have shows its photo, its place and how many you have, with big buttons: **+1**, **Used one**, **Set total…** (a keypad) and **Move to…**. A tap changes its stock straight away, with no scan inbox item, and **Undo** stays on the card until the next scan. Something new goes to the scan inbox and shows the same card you see there, so you can name it, pick a photo and file it anywhere; **Not now** leaves it in the inbox. A Cobblr label opens its thing.

**Settings** (the ⋯ in the corner): what a scan of something you have does (**Ask** shows the buttons; **One-tap** adds 1 or uses 1 on every scan and shows "Added 1 · Undo"), which collections the station keeps, where new things go, how long before it goes back to Ready to scan (8 seconds unless you change it), sound and flash, light or dark, and large text. An owner or admin can set an owner PIN; with one, the settings can be changed on the tablet itself.

If the network drops, taps wait on the tablet ("3 waiting to sync") and are sent in order when it is back, never counted twice. To stop a tablet, use **Stop this screen** under Devices → Stations.
