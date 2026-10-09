---
type: feature
scope: digifab
date: 2026-10-06
docs_target: docs/USER_GUIDE.md#CNC stations
docs_published: 2026-10-10
---
CNC stations now review posted programs, check stock and tools, pause for tool changes and track stock use and bit runtime.

## docs

Post the toolpath from your CAM program as an NC, G-code or TAP file and upload
it to the Digital Fabrication library. Queue it on a CNC machine and open its
machine station on the browser or tablet beside it. An owner or admin authorizes
that screen before Start.

At review, choose the loaded sheet or block and match each posted tool number to
an available wearing tool measured in hours in your inventory. Mount the first
tool before probing Z and keep the others ready beside the machine. Confirm the stock, tools, probed Z, G54 work
offset and clear clamps, plus the machine's spindle and extraction reminders.
Stock-top Z zero is required. Frame raises Z before tracing the program bounds
with the spindle off. Each M6 pauses with the tool's number and description.
Load the tool, check Z zero, and Resume. Pause, Resume and Stop remain available
without granting Start permission.

One bridge can run several machines. USB serial CNC machines use the same
bridge on Linux, Windows or macOS. Networked GRBL-family, Buildbotics-compatible
and LinuxCNC machines use a central bridge. No vendor desktop control app is
required. CAM remains separate: Cobblr does not generate toolpaths.

Scan the stock label or choose the stock on screen. A count blank needs saved
width, height and thickness in millimetres. Open Block dimensions to measure
it; open Bit diameter to save a library bit's diameter. Changing those details
clears the old physical checks. Sheet dimensions and remaining regions come
from its stock record.

For separate programs on a sheet, choose each library bit and use Find free
sheet area. It reuses rectangle nesting and includes the bit's radius. Set G54
at the displayed X and Y position on the stock, then repeat the physical
checks. The posted toolpath is not rewritten or rotated.

After the machine finishes or confirms Stop, record whether the piece came out
good or was scrap. Both use the sheet region or one whole count blank. Each
bit's actual runtime adds to its wearing-tool hours; time waiting for a tool
change is excluded. Stock use must be recorded before retrying or deleting
that job. If contact is lost, check the machine and confirm motion and the
spindle have stopped before reaching into it.

If the bridge no longer has the final runtime, the station asks for actual
seconds for every tool before recording the outcome. Enter 0 for a tool that
was never used. Values cannot be below runtime already observed, and the
machine must be idle. A partial recording keeps its original stock use and
verdict when you try again. Program estimates are not used to record bit hours.
