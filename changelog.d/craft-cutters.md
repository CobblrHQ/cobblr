---
type: feature
scope: digifab
date: 2026-10-06
docs_target: docs/USER_GUIDE.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-08
---
Added vinyl and craft cutter stations with mirrored heat-transfer cuts, tested material profiles and roll usage recorded in Inventory.

## docs

Open **Digifab**, connect a cutter through your bridge and choose **Open machine
station**. HPGL and DMPL cutters use serial, network or USB connections;
Silhouette Cameo and Portrait use USB. One bridge can serve many machines on
Linux, Windows or macOS, and any browser or tablet can be their station. A Pi
or a spare computer can serve USB machines. Network machines can share the
central bridge, including the built-in server bridge. Vendor desktop software
is not required. Cricut is unsupported because its protocol is cloud locked.

Configure the cutter's command language, usable width, feed range, coordinate
units and speed/force limits on the bridge. Match the machine's own settings.
Create a **roll** in Inventory with its width, remaining metres and waste per
job. At the station, choose a Library SVG/DXF or upload one, choose the roll and
save a material profile after a test cut on that machine. Profiles keep speed,
force, blade depth, passes and blade offset. Map every drawing layer to a
profile, choose the quantity and planning feed length, and prepare the cut.

Heat-transfer vinyl defaults to mirrored geometry. The preview displays
**Mirrored for heat transfer**. Check it before loading HTV. You can explicitly
change mirroring. Optional weed boxes and weed lines help remove excess vinyl;
weed lines stop outside placed designs. Blade compensation and weed margins
count toward the roll width. A wider design or insufficient remaining length
is refused.

An owner or admin authorizes the screen at the cutter. Load and align the chosen
roll, record it as loaded, then **Review cut**. Confirm blade depth, a zero native
blade offset, a checked test cut and clear origin. **Frame with blade up** checks
placement. Set a manual blade's depth at the machine; AutoBlade depth changes
only at Start. **Start cut** runs the reviewed file once. Stay beside the machine.
**Pause streaming**, **Resume streaming** and **Stop cutter** do not replace its
physical emergency stop. If the bridge cannot confirm Stop, use the physical
Stop and inspect the piece.

Some controllers cannot prove that a short cut or Frame finished. Confirm idle
and blade up at the authorized station before continuing. After a completed
cut, remove the piece and record its outcome and used metres. Failed or stopped
cuts are scrap; measure the partial length that left the roll. Waste is added
once. If recording stock use fails, the station and roll remain reserved.
Retry the same verdict and amount. Prepare a new plan to repeat a cut.

Registration marks, print-and-cut, Silhouette Bluetooth and rotary tools are not
supported. Cutter protocols are verified with simulators; physical machines
have not been verified.
