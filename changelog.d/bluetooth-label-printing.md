---
type: feature
scope: printing
date: 2026-07-20
docs_target: docs/USER_GUIDE.md#3.2 Labels
docs_published: 2026-08-07
---
**Print your labels straight to a Bluetooth thermal label printer**, with no print server and no cables. Add one under Configuration → Printers with the driver **"Bluetooth label printer"**, set the command dialect (most label printers speak TSPL; Phomemo M-series use ESC/POS raster), the media width and the label geometry, then use **Print test** to check it. From then on, the labels queue's **Send to printer** prints the queued rows to it: your real QR codes and descriptions, respecting each row's quantity. Your browser asks which printer to use once per session, not once per label. Because the dialect, width and calibration live on the printer connection, supporting a new model is a settings change rather than a code change, and if labels drift off the edge or come out upside down the gap and orientation fields fix it. Note that iOS has no Web Bluetooth, so iPhones and iPads cannot drive these printers from a web page. For iOS, or for printing without a browser open, use a CUPS printer or an edge bridge.

## docs
docs_target: docs/USER_GUIDE.md#3.2 Labels

Cobblr can print labels directly to a Bluetooth thermal label printer from Chrome or Edge on a desktop or Android device. Most cheap label printers have no network connection, so nothing on your network can reach them; your browser talks to them instead.

**Set one up** under **Configuration → Printers**, choosing the driver **Bluetooth label printer**:

- **Command dialect**: most cheap label printers speak **TSPL**. Phomemo M-series use **ESC/POS raster**. Get this right first, because a printer set to the wrong dialect accepts everything you send and prints nothing, which looks exactly like a broken printer.
- **Width (dots)**: these printers measure in dots at 8 per mm, so a 40 mm roll is 320 and a 2 inch printer is 384.
- **Label height, gap, orientation, top margin** (TSPL only): the geometry of your roll. The gap is the unprinted space between labels, and it is the number that matters most: if it is wrong, every label prints slightly further along than the last until your content walks off the edge.

Press **Print test** on the printer's row to check the connection. That prints a fixed test label, not one of yours.

**Printing your labels.** Queue labels as usual, then use **Send to printer** on the labels page. If your default printer is a Bluetooth one, your browser prints the queue directly: each row's own QR code and description, repeated for its quantity. Your browser asks which printer to use once per session rather than once per label, so a batch prints without interruption. If a label fails partway through, Cobblr finishes the rest and tells you which ones failed, since the paper for the successful ones is already used. Printed rows leave the queue and land in your print history the same as any other print, and a row that failed stays queued so you can retry just that one.

**Limits.** iPhones and iPads have no Web Bluetooth at all, so they cannot drive these printers from a web page. Printing without a browser open (from an automation, for example) also cannot use Bluetooth. For either case, use a CUPS printer or connect the printer to an edge bridge.
