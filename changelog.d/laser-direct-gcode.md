---
type: feature
scope: digifab
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#Direct laser jobs
---
Added direct G-code laser jobs with material profiles, a settings review, laser-off framing and station controls without requiring LightBurn.

## docs

Install the direct GRBL, FluidNC or grblHAL driver from Digital Fabrication's
Drivers catalog, then connect it to the controller's compatible HTTP manager.
Link the device to its machine and save the bed dimensions in millimetres.

Upload an SVG or DXF to the Library and choose **Prepare laser batch**. Select
the laser, choose **Add material profile** and enter settings you have tested on
that machine. Profiles currently need zero minimum power and zero focus offset;
set focus at the machine. LightBurn library import is optional.

Map each drawing layer to a profile, select physical sheets, preview the layout
and choose **Verify and queue sheet jobs**. Cobblr compiles the drawing and checks
the controller's stored file before queuing it.

Open the machine station on the screen beside the laser. Confirm the loaded
sheet, choose **Review and start**, check the compiled settings and choose
**Frame with laser off** to trace the bounds. The controller must report idle,
laser mode and its power scale. Homing-enabled controllers also need a homing
report; a controller without that report is refused. Then choose **Approve and
start laser**. A changed file, controller setting, sheet or saved bed requires
a fresh review or plan.

Use **Pause**, **Resume** and **Stop laser** at the station or floor manager.
Stop stays available while another station request is busy. Keep the machine
supervised and use its physical stop whenever needed. After the job finishes,
take out the pieces and record **Came out good?**; the used sheet area is kept
with the job.
