---
type: feature
scope: digifab
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#LightBurn job review
docs_published: 2026-10-08
---
Added a laser station that checks the loaded sheet, reviews prepared LightBurn files and approves Start beside the machine.

## docs

Prepared LightBurn files remember their material, thickness and minimum sheet
size. Set the tag when uploading a `.lbrn2` file, or edit it from its Library
card. Send the file to one laser, then open that machine's station from the
fleet card. The stable station link opens a tablet screen without app navigation.
An owner or admin signs in and authorizes that screen for the laser. Revoke
screens from Station settings.

Load the named sheet against the prepared file's corner stop. Scan its Cobblr QR
label, or pick an unlabelled sheet from inventory and save its sheet details.
An unlabelled sheet gets one reminder to print its label. Wrong material,
thickness, size or unavailable stock blocks Start with the reason. Review the
design and cut settings, then approve and start at the station. The current
sheet and file tag are checked again at Start. Other approval surfaces point to
the laser's station; three-dimensional printers keep their remote approval.

If LightBurn's file opening waits on a prompt, or Start is acknowledged without
running being reported, the station says LightBurn needs attention on its screen.
Take out the pieces and record good or scrap before the next job.
