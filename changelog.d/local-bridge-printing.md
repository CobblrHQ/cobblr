---
type: feature
scope: printing
date: 2026-07-28
docs_target: docs/USER_GUIDE.md#Print labels over Bluetooth
---
Print to a label printer attached to an edge bridge on your own computer, straight from the browser, with no relay token and no pairing to the cloud.

## docs

**A printer on an edge bridge on this computer.** If you run an edge bridge on
the same computer you browse from, Cobblr can print to its printers directly
from your browser. This suits a printer plugged into the machine you work at,
including a Bluetooth Classic label printer that no browser can reach on its
own, since the bridge holds the connection instead.

To set it up, add a printer, choose **Via edge bridge** as how Cobblr reaches
it, and fill in the bridge details:

1. **Instance on the bridge**: the short name the bridge's own config gives the
   printer, such as `labels`. The bridge serves each printer under its instance.
2. **Bridge on this computer**: the address the bridge listens on, normally
   `http://127.0.0.1:8077`. Setting this is what makes printing happen from
   your browser; leave it empty for a bridge elsewhere on your network, which
   pairs to Cobblr with a token instead.
3. If the bridge's config sets a token for that instance, paste it too, and set
   the label size so the preview is drawn at the right width.

The bridge holds the printer's calibration, so the dialect, margins and feed are
configured once in the bridge and Cobblr sends it the label as an image. You do
not set those twice.

If printing reports that it cannot reach the bridge, check the bridge is running
on this computer and that the address matches where it listens. A bridge only
accepts requests from web pages it trusts, so a self-hosted Cobblr on its own
domain needs that domain added to the bridge's `allowedOrigins` setting.
