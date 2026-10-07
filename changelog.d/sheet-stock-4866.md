---
type: feature
scope: inventory
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#Sheet stock
docs_published: 2026-10-08
---
Added sheet stock with cut outlines, undoable free-area edits, offcut search and QR labels for sheets and loaded spools.

## docs

Install **Sheets** from the bundle catalog. Add one record for each physical
piece, with its material, thickness, original width and height, colour or
finish, storage place and cost. Print its QR label from the record's label
action so the laser station can recognize it later.

The record's **Sheet area** drawing shades used material grey and outlines
usable room in blue. **Record a cut** accepts the bounding box of each placed
part, plus kerf and spacing in millimetres. X and Y are measured from the lower
left corner. An L-shaped cut keeps its inner corner free. Gaps under 20 mm in
either direction are left out; change **Smallest usable gap** for that material.
The remaining percentage counts overlapping outlines once. **Offcut below (%)**
starts at 25 percent.

After a saw cut, choose **Edit free area** and keep the rectangles still on the
piece. **Undo hand edit** restores the previous free area. A new recorded cut
ends that undo history so it cannot bring cut material back. If someone else
changes the sheet while your editor is open, your stale change is refused.
Close the editor and open it again to use the current area.

**Find a sheet** on an Inventory collection searches all sheet stock by
material, thickness and required width and height. Choose whether a quarter
turn is allowed. Fitting offcuts come first. Prepared LightBurn jobs still use
their saved origin, so an offcut that has space only elsewhere needs a positioned
design before it can be used at the laser station.

On a printer's Loaded filament panel, choose **Open printer station** for the
tablet screen. Scan a spool's QR label with the camera or a hardware scanner to
load it into a slot. The previous spool goes back to its shelf. **Queue QR label**
on a loaded spool adds its label to Labels for printing. This screen uses your
workspace sign-in; remote 3D job approval works as before.
