---
type: feature
scope: scan
date: 2026-08-11
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
You can now crop your own scan photo into the item's catalog picture, instead of
taking whatever the web turned up.

## docs

**Cropping your own photo into the catalog picture**

The photo you took is often the most accurate picture of a thing. It is
literally the object, in the condition you are filing it in. What it usually is
not is *framed* like a catalog shot: a marketplace listing screenshot has the
product in the top third and app chrome filling the rest, and a photo on a
workbench has the workbench in it.

So a scan item's catalog picture can now be a crop of your own photo. Give the
region as fractions of the photo and Cobblr cuts it out, pads it slightly, and
uses the result as the item's catalog image. It costs no AI call and no web
search, and it works when the AI is unavailable.

Two things worth knowing:

- The crop always comes off your **original** photo, not off the current catalog
  picture, so cropping a second time re-cuts from the full frame rather than
  compounding a crop of a crop.
- Your original photo is untouched. The crop is written as a new image, so the
  photo used to identify the item stays exactly as it was.

A crop is a catalog pick like any other, so the undo control steps back off it
to whatever the picture was before, and again from there.
